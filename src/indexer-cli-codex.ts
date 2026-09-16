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
import { indexNewMessages } from "./indexer";
import { codexSessionToMessages, deriveCodexSessionTitle } from "./codex-session-to-messages";
import { resolveBackendConfig } from "./config";
import { createProvider } from "./providers";
import { bootstrapHook, logHookError, logHookRun } from "./hook-runtime";

const HOOK_SOURCE = "codex";

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
  // Repair the environment when a GUI-launched host gave us a bare one.
  bootstrapHook(HOOK_SOURCE);

  const rawArg = process.argv[2];
  if (!rawArg) {
    logHookError(HOOK_SOURCE, "No payload argument provided");
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
    logHookError(HOOK_SOURCE, `Failed to parse payload: ${err}`);
    process.exit(1);
    return;
  }

  if (payload.type !== "agent-turn-complete") {
    process.exit(0);
  }

  const threadId = payload["thread-id"];
  const cwd = payload.cwd;

  if (!threadId) {
    logHookError(HOOK_SOURCE, "Missing thread-id in payload");
    process.exit(1);
  }

  const sessionFilePath = findSessionFile(threadId);
  if (!sessionFilePath) {
    logHookError(HOOK_SOURCE, `Session file not found for thread-id: ${threadId}`);
    process.exit(1);
  }

  const provider = await createProvider(resolveBackendConfig());

  try {
    const messages = codexSessionToMessages(sessionFilePath);
    if (messages.length === 0) return;

    const existingMeta = await provider.getSessionMeta(threadId);
    const title = existingMeta?.session_title
      || deriveCodexSessionTitle(messages, payload["last-assistant-message"]);

    const session = {
      id: threadId,
      title,
      directory: cwd ?? "",
    };

    const result = await indexNewMessages(provider, session, messages, "codex", { transcriptPath: sessionFilePath ?? undefined });
    logHookRun(HOOK_SOURCE, `session ${threadId}: ${result.indexed} chunk(s) indexed, ${result.skipped} skipped`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logHookError(HOOK_SOURCE, `Indexing error: ${msg}`);
  } finally {
    await provider.close();
  }
}

main().catch((err) => {
  logHookError(HOOK_SOURCE, `Fatal: ${err}`);
  process.exit(1);
});
