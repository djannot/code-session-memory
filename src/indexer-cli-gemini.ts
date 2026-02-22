#!/usr/bin/env node
/**
 * Entry point for Gemini CLI session indexing.
 *
 * Called by the Gemini CLI AfterAgent hook. Receives JSON on stdin:
 *   { session_id, transcript_path, cwd, hook_event_name, ... }
 *
 * Reads the session JSON transcript, converts to FullMessage[], and indexes
 * new messages into the shared sqlite-vec DB.
 */

import { resolveDbPath, openDatabase, getSessionMeta } from "./database";
import { indexNewMessages } from "./indexer";
import {
  geminiSessionToMessages,
  deriveGeminiSessionTitle,
} from "./gemini-session-to-messages";
import fs from "fs";
import os from "os";
import path from "path";

interface GeminiHookPayload {
  sessionId?: string;
  session_id?: string;
  transcriptPath?: string;
  transcript_path?: string;
  cwd?: string;
  workspaceRoot?: string;
  workspace_root?: string;
  hookEventName?: string;
  hook_event_name?: string;
  eventName?: string;
}

function getGeminiConfigDir(): string {
  return process.env.GEMINI_CONFIG_DIR ?? path.join(os.homedir(), ".gemini");
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function findTranscriptBySessionId(sessionId: string, cwd?: string): string | undefined {
  const tmpRoot = path.join(getGeminiConfigDir(), "tmp");
  const projectName = cwd ? path.basename(cwd) : undefined;

  const candidateDirs = [
    projectName ? path.join(tmpRoot, projectName, "chats") : undefined,
    path.join(tmpRoot),
  ].filter((d): d is string => Boolean(d && fs.existsSync(d)));

  const files: Array<{ filePath: string; mtimeMs: number }> = [];

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
        continue;
      }

      if (
        entry.isFile() &&
        entry.name.startsWith("session-") &&
        entry.name.endsWith(".json")
      ) {
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(fullPath).mtimeMs; } catch { /* ignore */ }
        files.push({ filePath: fullPath, mtimeMs });
      }
    }
  }

  for (const dir of candidateDirs) walk(dir);

  // Newest first, and keep the search bounded.
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const MAX_FILES_TO_CHECK = 200;

  for (const { filePath } of files.slice(0, MAX_FILES_TO_CHECK)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        sessionId?: string;
        session_id?: string;
      };
      const candidateId = parsed.sessionId ?? parsed.session_id;
      if (candidateId === sessionId) return filePath;
    } catch {
      // Ignore malformed files.
    }
  }

  return undefined;
}

async function main() {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  let payload: GeminiHookPayload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as GeminiHookPayload;
  } catch (err) {
    process.stderr.write(`[code-session-memory] Failed to parse stdin: ${err}\n`);
    process.exit(1);
    return;
  }

  const {
    sessionId: sessionIdCamel,
    session_id: sessionIdSnake,
    transcriptPath: transcriptPathCamel,
    transcript_path: transcriptPathSnake,
    cwd,
    workspaceRoot,
    workspace_root: workspaceRootSnake,
    hookEventName,
    hook_event_name: hookEventNameSnake,
    eventName,
  } = payload;

  const sessionId = sessionIdSnake ?? sessionIdCamel;
  const projectDir =
    getString(cwd) ??
    getString(workspaceRoot) ??
    getString(workspaceRootSnake) ??
    "";
  const hookEvent =
    hookEventNameSnake ??
    hookEventName ??
    eventName;
  const transcriptPath =
    transcriptPathSnake ??
    transcriptPathCamel ??
    (sessionId ? findTranscriptBySessionId(sessionId, projectDir) : undefined);

  if (!sessionId) {
    process.stderr.write("[code-session-memory] Missing session id in hook payload (session_id/sessionId)\n");
    process.exit(1);
    return;
  }

  // Index only completed turns if an event name is provided.
  if (hookEvent && hookEvent !== "AfterAgent") {
    process.exit(0);
    return;
  }

  if (!transcriptPath) {
    process.stderr.write("[code-session-memory] Missing transcript path in hook payload and could not auto-discover session file\n");
    process.exit(1);
    return;
  }

  const dbPath = resolveDbPath();
  const db = openDatabase({ dbPath });

  try {
    const messages = geminiSessionToMessages(transcriptPath);
    if (messages.length === 0) return;

    const existingMeta = getSessionMeta(db, sessionId);
    const title = existingMeta?.session_title || deriveGeminiSessionTitle(messages, sessionId);

    const session = {
      id: sessionId,
      title,
      directory: projectDir,
    };

    await indexNewMessages(db, session, messages, "gemini-cli");
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
