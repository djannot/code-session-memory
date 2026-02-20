import type { SessionInfo, FullMessage } from "./types";
import { resolveDbPath, openDatabase, getSessionMeta, upsertSessionMeta, insertChunks } from "./database";
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
// Indexer
// ---------------------------------------------------------------------------

/**
 * Incrementally indexes new messages from a session into the vector DB.
 *
 * Only messages that have not been previously indexed are processed:
 *   - We store the last indexed message ID in sessions_meta.
 *   - On each call, we filter to messages that come AFTER that ID.
 *   - Each new message is converted to markdown, chunked, embedded and stored.
 *
 * @param session   Session metadata (id, title, directory)
 * @param messages  All messages in the session (from client.session.messages())
 * @param options   Optional overrides for DB path and API key
 */
export async function indexNewMessages(
  session: SessionInfo,
  messages: FullMessage[],
  options: IndexerOptions = {},
): Promise<{ indexed: number; skipped: number }> {
  if (messages.length === 0) {
    return { indexed: 0, skipped: 0 };
  }

  const dbPath = resolveDbPath(options.dbPath);
  const db = openDatabase({ dbPath });

  try {
    const sessionId = session.id;
    const sessionTitle = session.title ?? sessionId;
    const project = session.directory ?? "";

    // Load or initialise the session meta record
    const meta = getSessionMeta(db, sessionId);
    const lastIndexedId = meta?.last_indexed_message_id ?? null;

    // Filter to only messages after the last indexed one
    let newMessages: FullMessage[];
    if (lastIndexedId === null) {
      newMessages = messages;
    } else {
      const lastIdx = messages.findIndex((m) => m.info.id === lastIndexedId);
      newMessages = lastIdx === -1 ? messages : messages.slice(lastIdx + 1);
    }

    if (newMessages.length === 0) {
      return { indexed: 0, skipped: messages.length };
    }

    const embedder = createEmbedder({
      apiKey: options.openAiApiKey,
      model: options.embeddingModel,
    });

    let totalChunksIndexed = 0;

    for (const msg of newMessages) {
      const md = messageToMarkdown(msg);
      if (!md.trim()) continue;

      const msgUrl = `session://${sessionId}#${msg.info.id}`;
      const chunks = chunkMarkdown(md, {
        sessionId,
        sessionTitle,
        project,
        baseUrl: msgUrl,
      });

      if (chunks.length === 0) continue;

      const texts = chunks.map((c) => c.content);
      const embeddings = await embedder.embedBatch(texts);

      insertChunks(db, chunks, embeddings);
      totalChunksIndexed += chunks.length;
    }

    // Update session meta with the last message we processed
    const lastMsg = newMessages[newMessages.length - 1];
    upsertSessionMeta(db, {
      session_id: sessionId,
      session_title: sessionTitle,
      project,
      last_indexed_message_id: lastMsg.info.id,
      updated_at: Date.now(),
    });

    return { indexed: newMessages.length, skipped: messages.length - newMessages.length };
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
  // Reset the last_indexed_message_id so all messages are treated as new
  const dbPath = resolveDbPath(options.dbPath);
  const db = openDatabase({ dbPath });
  try {
    upsertSessionMeta(db, {
      session_id: session.id,
      session_title: session.title ?? session.id,
      project: session.directory ?? "",
      last_indexed_message_id: null,
      updated_at: Date.now(),
    });
  } finally {
    db.close();
  }

  const result = await indexNewMessages(session, messages, options);
  return { indexed: result.indexed };
}
