import { exec } from "child_process";
import { loadConfig } from "./config";
import type { SessionSource } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PostHookContext {
  source: SessionSource;
  sessionId: string;
  sessionTitle?: string;
  project?: string;
  indexedCount: number;
  success: boolean;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Executes the user-configured post-hook command (if any) after indexing.
 *
 * Context is passed via CSM_* environment variables so the command can use
 * them freely (e.g. in a notification message).
 *
 * Fire-and-forget: does not block the indexer and silently logs errors to
 * stderr. A 10-second timeout prevents runaway commands from hanging the
 * process.
 */
export function runPostHookCommand(ctx: PostHookContext): void {
  const config = loadConfig();
  if (!config.postHookCommand) return;

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CSM_SOURCE: ctx.source,
    CSM_SESSION_ID: ctx.sessionId,
    CSM_SESSION_TITLE: ctx.sessionTitle ?? "",
    CSM_PROJECT: ctx.project ?? "",
    CSM_INDEXED_COUNT: String(ctx.indexedCount),
    CSM_SUCCESS: ctx.success ? "true" : "false",
    CSM_ERROR: ctx.errorMessage ?? "",
  };

  exec(config.postHookCommand, { env, timeout: 10_000 }, (err) => {
    if (err) {
      process.stderr.write(
        `[code-session-memory] post-hook command failed: ${err.message}\n`,
      );
    }
  });
}
