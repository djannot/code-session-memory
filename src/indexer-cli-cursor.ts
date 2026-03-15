#!/usr/bin/env node
/**
 * Entry point for Cursor session indexing.
 *
 * Called by the Cursor stop hook. Receives JSON on stdin:
 *   {
 *     conversation_id: string,   // the composerId
 *     workspace_roots: string[], // project directories
 *     transcript_path: string,   // path to the JSONL transcript (always complete)
 *     model: string,
 *     status: "completed" | "aborted" | "error",
 *     ...
 *   }
 *
 * Strategy:
 *   - Read messages from transcript_path (JSONL written by Cursor before the
 *     hook fires — always complete and race-condition-free).
 *   - Read session title from state.vscdb (best-effort, falls back to first
 *     user message).
 *   - Index new messages into the shared sqlite-vec DB incrementally.
 *
 * No retries needed: the transcript file is the authoritative source.
 */

import { resolveDbPath, openDatabase, getSessionMeta } from "./database";
import { indexNewMessages } from "./indexer";
import {
  resolveCursorDbPath,
  openCursorDb,
  getComposerData,
  deriveCursorSessionTitle,
  cursorSessionToMessages,
} from "./cursor-to-messages";
import { cursorTranscriptToMessages } from "./cursor-transcript-to-messages";

async function main() {
  // Read JSON payload from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  let payload: {
    conversation_id?: string;
    workspace_roots?: string[];
    model?: string;
    status?: string;
    transcript_path?: string | null;
  };
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (err) {
    process.stderr.write(`[code-session-memory] Failed to parse stdin: ${err}\n`);
    process.exit(1);
  }

  const {
    conversation_id: composerId,
    workspace_roots: workspaceRoots,
    transcript_path: transcriptPath,
  } = payload;

  if (!composerId) {
    process.stderr.write("[code-session-memory] Missing conversation_id in hook payload\n");
    process.exit(1);
  }

  if (!transcriptPath) {
    process.stderr.write("[code-session-memory] Missing transcript_path in hook payload — cannot index\n");
    return;
  }

  // Determine the project directory from workspace_roots
  const projectDir = (workspaceRoots ?? [])
    .map((r) => r.replace(/^file:\/\//, ""))
    .filter(Boolean)[0] ?? "";

  // Read messages from the transcript JSONL (guaranteed complete at hook time).
  const transcriptMessages = cursorTranscriptToMessages(transcriptPath, composerId);

  if (transcriptMessages.length === 0) {
    process.stderr.write(
      `[code-session-memory] No messages in transcript: ${transcriptPath}\n`,
    );
    return;
  }

  const dbPath = resolveDbPath();
  const db = openDatabase({ dbPath });

  try {
    // Try reading richer messages from Cursor's SQLite DB (has tool invocations
    // + timestamps). The DB may lag behind the transcript by a few seconds, so
    // we only use DB messages if the count is >= the transcript count.
    let messages = transcriptMessages;
    const existingMeta = getSessionMeta(db, composerId);
    let title = existingMeta?.session_title ?? "";

    try {
      const cursorDb = openCursorDb(resolveCursorDbPath());
      try {
        const dbMessages = cursorSessionToMessages(cursorDb, composerId);
        if (dbMessages.length >= transcriptMessages.length) {
          messages = dbMessages;
        }

        if (!title) {
          const composer = getComposerData(cursorDb, composerId);
          if (composer) {
            title = deriveCursorSessionTitle(composer, messages);
          }
        }
      } finally {
        cursorDb.close();
      }
    } catch {
      // SQLite unavailable — use transcript messages as fallback
    }

    if (!title) {
      for (const msg of messages) {
        if (msg.info.role === "user") {
          const part = msg.parts.find((p) => p.type === "text");
          if (part && part.type === "text") {
            title = (part.text ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
            break;
          }
        }
      }
    }

    const session = {
      id: composerId,
      title: title || composerId,
      directory: projectDir,
    };

    await indexNewMessages(db, session, messages, "cursor", { transcriptPath: transcriptPath ?? undefined });
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
