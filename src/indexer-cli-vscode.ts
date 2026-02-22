#!/usr/bin/env node
/**
 * Entry point for VS Code (Copilot agent) session indexing.
 *
 * Called by the VS Code Stop hook. Receives JSON on stdin:
 *   { timestamp, cwd, sessionId, hookEventName, transcript_path, stop_hook_active }
 *
 * Reads the transcript file, converts to FullMessage[], and indexes
 * new messages into the shared sqlite-vec DB.
 *
 * Runs as a Node.js subprocess (not Bun) so native addons load correctly.
 */

import { resolveDbPath, openDatabase, getSessionMeta } from "./database";
import { indexNewMessages } from "./indexer";
import { parseVscodeTranscript, deriveVscodeSessionTitle } from "./vscode-transcript-to-messages";
import type { FullMessage } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Returns true if the last meaningful message in the list is a tool result
 * (user message with tool-invocation:result parts only). This indicates the
 * JSONL was read before VS Code finished writing the final assistant
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

  let payload: {
    timestamp?: string;
    cwd?: string;
    sessionId?: string;
    hookEventName?: string;
    transcript_path?: string;
    stop_hook_active?: boolean;
  };
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    process.stderr.write(`[code-session-memory] Failed to parse stdin: ${err}\n`);
    process.exit(1);
  }

  const { sessionId, transcript_path: transcriptPath, cwd } = payload;

  if (!sessionId || !transcriptPath) {
    process.stderr.write("[code-session-memory] Missing sessionId or transcript_path in stdin\n");
    process.exit(1);
  }

  const dbPath = resolveDbPath();
  const db = openDatabase({ dbPath });

  try {
    // Parse the transcript — retry if the JSONL ends on a tool result,
    // which may mean the transcript is not fully written yet.
    let messages = parseVscodeTranscript(transcriptPath);
    if (messages.length === 0) return;

    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 500;

    for (let attempt = 0; attempt < MAX_RETRIES && endsWithToolResult(messages); attempt++) {
      await sleep(RETRY_DELAY_MS);
      messages = parseVscodeTranscript(transcriptPath);
    }

    // Build a session title from the first user message
    const existingMeta = getSessionMeta(db, sessionId);
    const title = existingMeta?.session_title || deriveVscodeSessionTitle(messages);

    const session = {
      id: sessionId,
      title,
      directory: cwd ?? "",
    };

    await indexNewMessages(db, session, messages, "vscode");
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
