#!/usr/bin/env node
/**
 * Entry point for Antigravity 2.x session indexing.
 *
 * Called by the Antigravity `Stop` lifecycle hook (configured in
 * `~/.gemini/config/hooks.json`). Antigravity encodes hook payloads with
 * protojson, so every key is camelCase. Received on stdin:
 *   {
 *     conversationId, workspacePaths[], transcriptPath, artifactDirectoryPath,
 *     modelName, lastUserInput, executionNum, terminationReason, error, fullyIdle
 *   }
 *
 * Reads the JSONL transcript, converts to FullMessage[], and indexes new
 * messages into the shared sqlite-vec DB.
 *
 * Unlike the other hosts, Antigravity reads the hook's stdout: it must be a
 * JSON object, and a `decision` of "continue" would push the agent back into
 * its loop. We always emit a non-continue decision so indexing can never keep
 * a turn alive. The hook also blocks the agent loop while it runs, which is why
 * the installer gives it a generous timeout.
 *
 * The same hook serves all three Antigravity surfaces (the 2.x app, the IDE and
 * the CLI); they differ only by the directory inside `~/.gemini`.
 */

import { indexNewMessages } from "./indexer";
import {
  antigravityTranscriptToMessages,
  deriveAntigravitySessionTitle,
} from "./antigravity-transcript-to-messages";
import { discoverAntigravityTranscript } from "./transcript-discovery";
import { resolveBackendConfig } from "./config";
import { createProvider } from "./providers";
import { bootstrapHook, logHookError, logHookRun } from "./hook-runtime";

const HOOK_SOURCE = "antigravity";

interface AntigravityHookPayload {
  conversationId?: string;
  conversation_id?: string;
  transcriptPath?: string;
  transcript_path?: string;
  workspacePaths?: unknown;
  workspace_paths?: unknown;
  modelName?: string;
  model_name?: string;
  terminationReason?: string;
  termination_reason?: string;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstWorkspacePath(...candidates: unknown[]): string {
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      const value = getString(entry);
      if (!value) continue;
      // Antigravity reports workspaces as plain paths, but file:// URIs show up
      // in some surfaces.
      return value.startsWith("file://") ? decodeURIComponent(value.slice(7)) : value;
    }
  }
  return "";
}

/** Antigravity reads stdout: anything but `decision: "continue"` lets the turn end. */
function allowStop(): void {
  process.stdout.write(JSON.stringify({ decision: "stop" }));
}

async function main() {
  // Repair the environment when a GUI-launched host gave us a bare one.
  bootstrapHook(HOOK_SOURCE);

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }

  let payload: AntigravityHookPayload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AntigravityHookPayload;
  } catch (err) {
    logHookError(HOOK_SOURCE, `Failed to parse stdin: ${err}`);
    allowStop();
    process.exit(1);
    return;
  }

  const conversationId =
    getString(payload.conversationId) ?? getString(payload.conversation_id);
  const modelName = getString(payload.modelName) ?? getString(payload.model_name);
  const projectDir = firstWorkspacePath(payload.workspacePaths, payload.workspace_paths);

  if (!conversationId) {
    logHookError(HOOK_SOURCE, "Missing conversation id in hook payload (conversationId)");
    allowStop();
    process.exit(1);
    return;
  }

  const transcriptPath =
    getString(payload.transcriptPath) ??
    getString(payload.transcript_path) ??
    discoverAntigravityTranscript(conversationId) ??
    undefined;

  if (!transcriptPath) {
    logHookError(
      HOOK_SOURCE,
      `Missing transcript path in hook payload and could not auto-discover the transcript for conversation ${conversationId}`,
    );
    allowStop();
    process.exit(1);
    return;
  }

  const provider = await createProvider(resolveBackendConfig());

  try {
    const messages = antigravityTranscriptToMessages(transcriptPath, {
      conversationId,
      modelName,
    });
    if (messages.length === 0) return;

    const existingMeta = await provider.getSessionMeta(conversationId);
    const title =
      existingMeta?.session_title || deriveAntigravitySessionTitle(messages, conversationId);

    const session = {
      id: conversationId,
      title,
      directory: projectDir,
    };

    const result = await indexNewMessages(provider, session, messages, "antigravity", {
      transcriptPath,
    });
    logHookRun(
      HOOK_SOURCE,
      `conversation ${conversationId}: ${result.indexed} chunk(s) indexed, ${result.skipped} skipped`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logHookError(HOOK_SOURCE, `Indexing error: ${msg}`);
  } finally {
    await provider.close();
    allowStop();
  }
}

main().catch((err) => {
  logHookError(HOOK_SOURCE, `Fatal: ${err}`);
  allowStop();
  process.exit(1);
});
