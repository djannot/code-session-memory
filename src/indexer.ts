import type { SessionInfo, FullMessage, SessionSource } from "./types";
import type { Database } from "./database";
import { resolveDbPath, openDatabase, getSessionMeta, upsertSessionMeta, insertChunks, deleteSession } from "./database";
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
 * @param source    Which tool produced the session ("opencode" | "claude-code")
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

  if (newMessages.length === 0) {
    return { indexed: 0, skipped: messages.length };
  }

  const embedder = createEmbedder({
    apiKey: options.openAiApiKey,
    model: options.embeddingModel,
  });

  // Single timestamp for all chunks in this indexing run — represents when
  // the session turn was indexed (within seconds of when it was written).
  const indexedAt = Date.now();

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
