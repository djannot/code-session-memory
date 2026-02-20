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
import type { FullMessage } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Returns true if the last meaningful message in the list is a tool result
 * (user message with tool-invocation:result parts only). This indicates the
 * JSONL was read before Claude Code finished writing the final assistant
 * response — we should retry.
 */
function endsWithToolResult(messages: FullMessage[]): boolean {
  if (messages.length === 0) return false;
  const last = messages[messages.length - 1];
  if (last.info.role !== "user") return false;
  return last.parts.every(
    (p) => p.type === "tool-invocation" && p.state === "result",
  );
}

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
    // Parse the transcript — retry if the JSONL ends on a tool result,
    // which means Claude Code hasn't finished writing the final assistant
    // response yet (race condition between hook firing and JSONL flush).
    let messages = parseTranscript(transcriptPath);
    if (messages.length === 0) return;

    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 500;

    for (let attempt = 0; attempt < MAX_RETRIES && endsWithToolResult(messages); attempt++) {
      await sleep(RETRY_DELAY_MS);
      messages = parseTranscript(transcriptPath);
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
