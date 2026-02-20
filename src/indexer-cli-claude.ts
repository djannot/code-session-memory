#!/usr/bin/env node
/**
 * Entry point for Claude Code session indexing.
 *
 * Called by the Claude Code Stop hook. Receives JSON on stdin:
 *   { session_id, transcript_path, cwd, ... }
 *
 * Reads the transcript file, converts to FullMessage[], and indexes
 * new messages into the shared sqlite-vec DB.
 *
 * Runs as a Node.js subprocess (not Bun) so native addons load correctly.
 */

import { resolveDbPath, openDatabase, getSessionMeta } from "./database";
import { indexNewMessages } from "./indexer";
import { parseTranscript, deriveSessionTitle } from "./transcript-to-messages";

async function main() {
  // Read JSON payload from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  let payload: { session_id?: string; transcript_path?: string; cwd?: string };
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    process.stderr.write(`[code-session-memory] Failed to parse stdin: ${err}\n`);
    process.exit(1);
  }

  const { session_id: sessionId, transcript_path: transcriptPath, cwd } = payload;

  if (!sessionId || !transcriptPath) {
    process.stderr.write("[code-session-memory] Missing session_id or transcript_path in stdin\n");
    process.exit(1);
  }

  const dbPath = resolveDbPath();
  const db = openDatabase({ dbPath });

  try {
    // Parse the transcript
    const messages = parseTranscript(transcriptPath);
    if (messages.length === 0) {
      return;
    }

    // Build a session title from the first user message
    const existingMeta = getSessionMeta(db, sessionId);
    const title = existingMeta?.session_title || deriveSessionTitle(messages);

    const session = {
      id: sessionId,
      title,
      directory: cwd ?? "",
    };

    await indexNewMessages(db, session, messages, "claude-code");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[code-session-memory] Indexing error: ${msg}\n`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  process.stderr.write(`[code-session-memory] Fatal: ${err}\n`);
  process.exit(1);
});
