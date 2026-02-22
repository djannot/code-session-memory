#!/usr/bin/env node
/**
 * Entry point for Codex (OpenAI CLI) session indexing.
 *
 * Called by the Codex notify hook. Receives JSON as process.argv[2]:
 *   { type, "thread-id", "turn-id", cwd, "input-messages", "last-assistant-message" }
 *
 * Locates the session JSONL under ~/.codex/sessions/ ending with -<thread-id>.jsonl,
 * converts to FullMessage[], and indexes new messages into the shared DB.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { resolveDbPath, openDatabase, getSessionMeta } from "./database";
import { indexNewMessages } from "./indexer";
import { codexSessionToMessages, deriveCodexSessionTitle } from "./codex-session-to-messages";

function getCodexHome(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function findSessionFile(threadId: string): string | null {
  const sessionsDir = path.join(getCodexHome(), "sessions");
  if (!fs.existsSync(sessionsDir)) return null;

  const matches: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) {
        matches.push(fullPath);
      }
    }
  }

  walk(sessionsDir);

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  // Prefer the newest match in case multiple historical rollouts share thread ID.
  matches.sort((a, b) => {
    let aTime = 0;
    let bTime = 0;
    try { aTime = fs.statSync(a).mtimeMs; } catch { /* ignore */ }
    try { bTime = fs.statSync(b).mtimeMs; } catch { /* ignore */ }
    return bTime - aTime;
  });
  return matches[0];
}

async function main() {
  const rawArg = process.argv[2];
  if (!rawArg) {
    process.stderr.write("[code-session-memory] No payload argument provided\n");
    process.exit(1);
  }

  let payload: {
    type?: string;
    "thread-id"?: string;
    "turn-id"?: string;
    cwd?: string;
    "input-messages"?: string[];
    "last-assistant-message"?: string;
  };

  try {
    payload = JSON.parse(rawArg);
  } catch (err) {
    process.stderr.write(`[code-session-memory] Failed to parse payload: ${err}\n`);
    process.exit(1);
    return;
  }

  if (payload.type !== "agent-turn-complete") {
    process.exit(0);
  }

  const threadId = payload["thread-id"];
  const cwd = payload.cwd;

  if (!threadId) {
    process.stderr.write("[code-session-memory] Missing thread-id in payload\n");
    process.exit(1);
  }

  const sessionFilePath = findSessionFile(threadId);
  if (!sessionFilePath) {
    process.stderr.write(`[code-session-memory] Session file not found for thread-id: ${threadId}\n`);
    process.exit(1);
  }

  const dbPath = resolveDbPath();
  const db = openDatabase({ dbPath });

  try {
    const messages = codexSessionToMessages(sessionFilePath);
    if (messages.length === 0) return;

    const existingMeta = getSessionMeta(db, threadId);
    const title = existingMeta?.session_title
      || deriveCodexSessionTitle(messages, payload["last-assistant-message"]);

    const session = {
      id: threadId,
      title,
      directory: cwd ?? "",
    };

    await indexNewMessages(db, session, messages, "codex");
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
