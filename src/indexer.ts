import type { SessionInfo, FullMessage, SessionSource, ToolState, MessageRow, ToolCallRow } from "./types";
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
}

// ---------------------------------------------------------------------------
// Core indexer (accepts an already-open DB)
// ---------------------------------------------------------------------------

/**
 * Incrementally indexes new messages from a session into the vector DB.
 *
 * Only messages that have not been previously indexed are processed:
 *   - We store the last indexed message ID in sessions_meta.
 *   - On each call, we filter to messages that come AFTER that ID.
 *   - Each new message is converted to markdown, chunked, embedded and stored.
 *
 * @param db        Already-open database connection (caller manages lifecycle)
 * @param session   Session metadata (id, title, directory)
 * @param messages  All messages in the session
 * @param source    Which tool produced the session ("opencode" | "claude-code" | "cursor" | "vscode" | "codex" | "gemini-cli")
 * @param options   Optional overrides for API key / model
 */
export async function indexNewMessages(
  db: Database,
  session: SessionInfo,
  messages: FullMessage[],
  source: SessionSource = "opencode",
  options: Pick<IndexerOptions, "openAiApiKey" | "embeddingModel"> = {},
): Promise<{ indexed: number; skipped: number }> {
  if (messages.length === 0) {
    return { indexed: 0, skipped: 0 };
  }

  const sessionId = session.id;
  const sessionTitle = session.title ?? sessionId;
  const project = session.directory ?? "";

  // Load or initialise the session meta record
  const meta = getSessionMeta(db, sessionId);
  const lastIndexedId = meta?.last_indexed_message_id ?? null;

  // Filter to only messages after the last indexed one.
  // If lastIndexedId is set but not found in the message list, this means the
  // ID format changed (e.g. migrating from SQLite bubble IDs to transcript line
  // IDs). In that case, purge the existing session chunks and re-index from
  // scratch to avoid duplicates.
  let newMessages: FullMessage[];
  if (lastIndexedId === null) {
    newMessages = messages;
  } else {
    const lastIdx = messages.findIndex((m) => m.info.id === lastIndexedId);
    if (lastIdx === -1) {
      // ID not found — purge stale chunks and re-index everything
      deleteSession(db, sessionId);
      newMessages = messages;
    } else {
      newMessages = messages.slice(lastIdx + 1);
    }
  }

  // --- Phase 0: extract structured data for analytics tables ---
  // Process ALL messages (not just new ones) so that sessions indexed before
  // the analytics tables were added get their messages/tool_calls populated.
  // INSERT OR IGNORE makes this idempotent — already-indexed rows are skipped.
  const indexedAt = Date.now();
  const messageRows: MessageRow[] = [];
  const toolCallRows: ToolCallRow[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const messageOrder = i;
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
      message_order: messageOrder,
      indexed_at: indexedAt,
    });

    // Extract tool calls from message parts
    for (const part of msg.parts) {
      if (part.type === "tool-invocation" && part.toolName !== "tool_result") {
        // Claude Code, Cursor DB, VS Code, Codex, Gemini format
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
        // OpenCode format — normalize field names
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

  // Batch insert structured data.
  // Messages use INSERT OR IGNORE (idempotent via PK).
  // Tool calls have no unique constraint, so clear and re-insert for the session.
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

  // The first new message's position within the full session (0-based).
  // Used to assign stable message_order values so chunks sort chronologically
  // regardless of message ID format (works for OpenCode, Claude Code, Cursor).
  const firstNewMessageOrder = messages.length - newMessages.length;

  // --- Phase 1: render + chunk all new messages up-front ---
  // This lets us embed everything in a single API call instead of one per message.
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

    // Stamp every chunk with the indexing time and message position
    const messageOrder = firstNewMessageOrder + i;
    for (const chunk of chunks) {
      chunk.metadata.created_at = indexedAt;
      chunk.metadata.message_order = messageOrder;
    }

    perMessage.push({ chunks });
    allTexts.push(...chunks.map((c) => c.content));
  }

  // --- Phase 2: embed all chunks in one batch ---
  const allEmbeddings = allTexts.length > 0 ? await embedder.embedBatch(allTexts) : [];

  // --- Phase 3: slice embeddings back per message and insert ---
  let embeddingOffset = 0;
  for (const { chunks } of perMessage) {
    if (chunks.length === 0) continue;
    const embeddings = allEmbeddings.slice(embeddingOffset, embeddingOffset + chunks.length);
    insertChunks(db, chunks, embeddings);
    embeddingOffset += chunks.length;
  }

  // Update session meta with the last message we processed
  const lastMsg = newMessages[newMessages.length - 1];
  upsertSessionMeta(db, {
    session_id: sessionId,
    session_title: sessionTitle,
    project,
    source,
    last_indexed_message_id: lastMsg.info.id,
    updated_at: Date.now(),
  });

  // Flush WAL to the main DB file so that a subsequent status check on a
  // separate connection sees the newly indexed data immediately.
  db.pragma("wal_checkpoint(PASSIVE)");

  return { indexed: newMessages.length, skipped: messages.length - newMessages.length };
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
    // Reset the last_indexed_message_id so all messages are treated as new
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
