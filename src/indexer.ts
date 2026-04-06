import type { SessionInfo, FullMessage, SessionSource, ToolState, MessageRow, ToolCallRow } from "./types";
import type { DatabaseProvider } from "./providers/types";
import type { Database } from "./database";
import { resolveDbPath, openDatabase, getSessionMeta, upsertSessionMeta, insertChunks, insertMessages, insertToolCalls, deleteSession } from "./database";
import { chunkMarkdown } from "./chunker";
import { createEmbedder } from "./embedder";
import { messageToMarkdown } from "./session-to-md";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IndexerOptions {
  /** Override the DB path (useful for testing). Falls back to resolveDbPath(). */
  dbPath?: string;
  /** Override the OpenAI API key. Falls back to OPENAI_API_KEY env var. */
  openAiApiKey?: string;
  /** Override the embedding model. Falls back to text-embedding-3-large. */
  embeddingModel?: string;
  /** Path to the original transcript file. Stored in sessions_meta for re-indexing. */
  transcriptPath?: string;
}

// ---------------------------------------------------------------------------
// Core indexer (accepts a DatabaseProvider — async interface)
// ---------------------------------------------------------------------------

/**
 * Incrementally indexes new messages from a session into the vector DB.
 *
 * Accepts either a DatabaseProvider (async, backend-agnostic) or a legacy
 * Database handle (sync, SQLite only). New callers should use DatabaseProvider.
 *
 * Only messages that have not been previously indexed are processed:
 *   - We store the last indexed message ID in sessions_meta.
 *   - On each call, we filter to messages that come AFTER that ID.
 *   - Each new message is converted to markdown, chunked, embedded and stored.
 */
export async function indexNewMessages(
  db: Database | DatabaseProvider,
  session: SessionInfo,
  messages: FullMessage[],
  source: SessionSource = "opencode",
  options: Pick<IndexerOptions, "openAiApiKey" | "embeddingModel" | "transcriptPath"> = {},
): Promise<{ indexed: number; skipped: number }> {
  // Detect if we received a DatabaseProvider (has backendType) or a raw Database
  if ("backendType" in db) {
    return _indexNewMessagesViaProvider(db as DatabaseProvider, session, messages, source, options);
  }
  return indexNewMessagesLegacy(db as Database, session, messages, source, options);
}

// ---------------------------------------------------------------------------
// Provider-based implementation (async, backend-agnostic)
// ---------------------------------------------------------------------------

async function _indexNewMessagesViaProvider(
  provider: DatabaseProvider,
  session: SessionInfo,
  messages: FullMessage[],
  source: SessionSource,
  options: Pick<IndexerOptions, "openAiApiKey" | "embeddingModel" | "transcriptPath">,
): Promise<{ indexed: number; skipped: number }> {
  if (messages.length === 0) return { indexed: 0, skipped: 0 };

  const sessionId = session.id;
  const sessionTitle = session.title ?? sessionId;
  const project = session.directory ?? "";

  const meta = await provider.getSessionMeta(sessionId);
  const lastIndexedId = meta?.last_indexed_message_id ?? null;

  let newMessages: FullMessage[];
  if (lastIndexedId === null) {
    newMessages = messages;
  } else {
    const lastIdx = messages.findIndex((m) => m.info.id === lastIndexedId);
    if (lastIdx === -1) {
      await provider.deleteSession(sessionId);
      newMessages = messages;
    } else {
      newMessages = messages.slice(lastIdx + 1);
    }
  }

  // --- Phase 0: extract structured data for analytics tables ---
  const indexedAt = Date.now();
  const { messageRows, toolCallRows } = extractAnalyticsData(messages, sessionId, indexedAt);

  await provider.insertMessages(messageRows);
  if (toolCallRows.length > 0) {
    await provider.deleteToolCallsBySession(sessionId);
  }
  await provider.insertToolCalls(toolCallRows);

  if (newMessages.length === 0) {
    return { indexed: 0, skipped: messages.length };
  }

  const embedder = createEmbedder({
    apiKey: options.openAiApiKey,
    model: options.embeddingModel,
  });

  const firstNewMessageOrder = messages.length - newMessages.length;

  // --- Phase 1: render + chunk ---
  type MessageChunks = { chunks: ReturnType<typeof chunkMarkdown> };
  const perMessage: MessageChunks[] = [];
  const allTexts: string[] = [];

  for (let i = 0; i < newMessages.length; i++) {
    const msg = newMessages[i];
    const md = messageToMarkdown(msg);
    if (!md.trim()) {
      perMessage.push({ chunks: [] });
      continue;
    }

    const msgUrl = `session://${sessionId}#${msg.info.id}`;
    const chunks = chunkMarkdown(md, {
      sessionId,
      sessionTitle,
      project,
      baseUrl: msgUrl,
    });

    const messageOrder = firstNewMessageOrder + i;
    for (const chunk of chunks) {
      chunk.metadata.created_at = indexedAt;
      chunk.metadata.message_order = messageOrder;
    }

    perMessage.push({ chunks });
    allTexts.push(...chunks.map((c) => c.content));
  }

  // --- Phase 2: embed ---
  const allEmbeddings = allTexts.length > 0 ? await embedder.embedBatch(allTexts) : [];

  // --- Phase 3: insert ---
  let embeddingOffset = 0;
  for (const { chunks } of perMessage) {
    if (chunks.length === 0) continue;
    const embeddings = allEmbeddings.slice(embeddingOffset, embeddingOffset + chunks.length);
    await provider.insertChunks(chunks, embeddings);
    embeddingOffset += chunks.length;
  }

  await provider.upsertSessionMeta({
    session_id: sessionId,
    session_title: sessionTitle,
    project,
    source,
    last_indexed_message_id: newMessages[newMessages.length - 1].info.id,
    updated_at: Date.now(),
    transcript_path: options.transcriptPath,
  });

  await provider.checkpoint();

  return { indexed: newMessages.length, skipped: messages.length - newMessages.length };
}

// ---------------------------------------------------------------------------
// Legacy implementation (sync Database — preserved for backward compat)
// ---------------------------------------------------------------------------

async function indexNewMessagesLegacy(
  db: Database,
  session: SessionInfo,
  messages: FullMessage[],
  source: SessionSource,
  options: Pick<IndexerOptions, "openAiApiKey" | "embeddingModel" | "transcriptPath">,
): Promise<{ indexed: number; skipped: number }> {
  if (messages.length === 0) return { indexed: 0, skipped: 0 };

  const sessionId = session.id;
  const sessionTitle = session.title ?? sessionId;
  const project = session.directory ?? "";

  const meta = getSessionMeta(db, sessionId);
  const lastIndexedId = meta?.last_indexed_message_id ?? null;

  let newMessages: FullMessage[];
  if (lastIndexedId === null) {
    newMessages = messages;
  } else {
    const lastIdx = messages.findIndex((m) => m.info.id === lastIndexedId);
    if (lastIdx === -1) {
      deleteSession(db, sessionId);
      newMessages = messages;
    } else {
      newMessages = messages.slice(lastIdx + 1);
    }
  }

  // --- Phase 0: extract structured data ---
  const indexedAt = Date.now();
  const { messageRows, toolCallRows } = extractAnalyticsData(messages, sessionId, indexedAt);

  insertMessages(db, messageRows);
  if (toolCallRows.length > 0) {
    db.prepare("DELETE FROM tool_calls WHERE session_id = ?").run(sessionId);
  }
  insertToolCalls(db, toolCallRows);

  if (newMessages.length === 0) {
    return { indexed: 0, skipped: messages.length };
  }

  const embedder = createEmbedder({
    apiKey: options.openAiApiKey,
    model: options.embeddingModel,
  });

  const firstNewMessageOrder = messages.length - newMessages.length;

  type MessageChunks = { chunks: ReturnType<typeof chunkMarkdown> };
  const perMessage: MessageChunks[] = [];
  const allTexts: string[] = [];

  for (let i = 0; i < newMessages.length; i++) {
    const msg = newMessages[i];
    const md = messageToMarkdown(msg);
    if (!md.trim()) {
      perMessage.push({ chunks: [] });
      continue;
    }

    const msgUrl = `session://${sessionId}#${msg.info.id}`;
    const chunks = chunkMarkdown(md, {
      sessionId,
      sessionTitle,
      project,
      baseUrl: msgUrl,
    });

    const messageOrder = firstNewMessageOrder + i;
    for (const chunk of chunks) {
      chunk.metadata.created_at = indexedAt;
      chunk.metadata.message_order = messageOrder;
    }

    perMessage.push({ chunks });
    allTexts.push(...chunks.map((c) => c.content));
  }

  const allEmbeddings = allTexts.length > 0 ? await embedder.embedBatch(allTexts) : [];

  let embeddingOffset = 0;
  for (const { chunks } of perMessage) {
    if (chunks.length === 0) continue;
    const embeddings = allEmbeddings.slice(embeddingOffset, embeddingOffset + chunks.length);
    insertChunks(db, chunks, embeddings);
    embeddingOffset += chunks.length;
  }

  const lastMsg = newMessages[newMessages.length - 1];
  upsertSessionMeta(db, {
    session_id: sessionId,
    session_title: sessionTitle,
    project,
    source,
    last_indexed_message_id: lastMsg.info.id,
    updated_at: Date.now(),
    transcript_path: options.transcriptPath,
  });

  db.pragma("wal_checkpoint(PASSIVE)");

  return { indexed: newMessages.length, skipped: messages.length - newMessages.length };
}

// ---------------------------------------------------------------------------
// Shared helper: extract analytics rows from messages
// ---------------------------------------------------------------------------

function extractAnalyticsData(
  messages: FullMessage[],
  sessionId: string,
  indexedAt: number,
): { messageRows: MessageRow[]; toolCallRows: ToolCallRow[] } {
  const messageRows: MessageRow[] = [];
  const toolCallRows: ToolCallRow[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const createdAt = msg.info.time?.created ?? null;

    let textLength = 0;
    let toolCallCount = 0;
    for (const part of msg.parts) {
      if (part.type === "text" && part.text) textLength += part.text.length;
      if ((part.type === "tool-invocation" && part.toolName !== "tool_result") || part.type === "tool") toolCallCount++;
    }

    messageRows.push({
      id: msg.info.id,
      session_id: sessionId,
      role: msg.info.role,
      created_at: createdAt,
      text_length: textLength,
      part_count: msg.parts.length,
      tool_call_count: toolCallCount,
      message_order: i,
      indexed_at: indexedAt,
    });

    for (const part of msg.parts) {
      if (part.type === "tool-invocation" && part.toolName !== "tool_result") {
        const status = typeof part.state === "string" ? part.state : null;
        toolCallRows.push({
          message_id: msg.info.id,
          session_id: sessionId,
          tool_name: part.toolName ?? "unknown",
          tool_call_id: part.toolCallId ?? null,
          status,
          has_error: status === "error" ? 1 : 0,
          args_length: part.args ? JSON.stringify(part.args).length : 0,
          result_length: part.result
            ? (typeof part.result === "string" ? part.result.length : JSON.stringify(part.result).length)
            : 0,
          created_at: createdAt,
          indexed_at: indexedAt,
        });
      } else if (part.type === "tool") {
        const state = part.state as ToolState | undefined;
        toolCallRows.push({
          message_id: msg.info.id,
          session_id: sessionId,
          tool_name: part.tool ?? "unknown",
          tool_call_id: part.callID ?? null,
          status: state?.status ?? null,
          has_error: state?.error ? 1 : 0,
          args_length: state?.input ? JSON.stringify(state.input).length : 0,
          result_length: state?.output
            ? (typeof state.output === "string" ? state.output.length : JSON.stringify(state.output).length)
            : 0,
          created_at: createdAt,
          indexed_at: indexedAt,
        });
      }
    }
  }

  return { messageRows, toolCallRows };
}

// ---------------------------------------------------------------------------
// Convenience wrappers (open+close their own DB connection)
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper that opens its own DB connection.
 * Used by the OpenCode indexer-cli and by tests.
 */
export async function indexNewMessagesWithOptions(
  session: SessionInfo,
  messages: FullMessage[],
  source: SessionSource = "opencode",
  options: IndexerOptions = {},
): Promise<{ indexed: number; skipped: number }> {
  if (messages.length === 0) return { indexed: 0, skipped: 0 };

  const dbPath = resolveDbPath(options.dbPath);
  const db = openDatabase({ dbPath });
  try {
    return await indexNewMessages(db, session, messages, source, options);
  } finally {
    db.close();
  }
}

/**
 * Re-indexes all messages in a session from scratch.
 * Useful for repairing a corrupted or stale index.
 */
export async function reindexSession(
  session: SessionInfo,
  messages: FullMessage[],
  options: IndexerOptions = {},
): Promise<{ indexed: number }> {
  const dbPath = resolveDbPath(options.dbPath);
  const db = openDatabase({ dbPath });
  try {
    const existing = getSessionMeta(db, session.id);
    upsertSessionMeta(db, {
      session_id: session.id,
      session_title: session.title ?? session.id,
      project: session.directory ?? "",
      source: existing?.source ?? "opencode",
      last_indexed_message_id: null,
      updated_at: Date.now(),
    });
    const result = await indexNewMessages(db, session, messages, existing?.source ?? "opencode", options);
    return { indexed: result.indexed };
  } finally {
    db.close();
  }
}

/**
 * Convenience wrapper using DatabaseProvider.
 * Used by indexer CLIs that have already resolved their backend config.
 */
export async function indexNewMessagesWithProvider(
  provider: DatabaseProvider,
  session: SessionInfo,
  messages: FullMessage[],
  source: SessionSource = "opencode",
  options: Pick<IndexerOptions, "openAiApiKey" | "embeddingModel" | "transcriptPath"> = {},
): Promise<{ indexed: number; skipped: number }> {
  if (messages.length === 0) return { indexed: 0, skipped: 0 };
  return indexNewMessages(provider, session, messages, source, options);
}

/**
 * Re-indexes all messages in a session from scratch using DatabaseProvider.
 */
export async function reindexSessionWithProvider(
  provider: DatabaseProvider,
  session: SessionInfo,
  messages: FullMessage[],
  options: Pick<IndexerOptions, "openAiApiKey" | "embeddingModel" | "transcriptPath"> = {},
): Promise<{ indexed: number }> {
  const existing = await provider.getSessionMeta(session.id);
  await provider.upsertSessionMeta({
    session_id: session.id,
    session_title: session.title ?? session.id,
    project: session.directory ?? "",
    source: existing?.source ?? "opencode",
    last_indexed_message_id: null,
    updated_at: Date.now(),
  });
  const result = await indexNewMessages(provider, session, messages, existing?.source ?? "opencode", options);
  return { indexed: result.indexed };
}
