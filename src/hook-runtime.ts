/**
 * Shared bootstrap for hook entry points.
 *
 * Every indexer CLI calls bootstrapHook() before doing any work: it repairs
 * the environment a GUI-launched host failed to provide (see runtime-env.ts)
 * and records what happened in the hook log, so a silent failure becomes a
 * diagnosable one.
 */

import { hydrateEnv } from "./runtime-env";
import { logHook, logHookError } from "./hook-log";

export function bootstrapHook(source: string): void {
  const result = hydrateEnv();

  if (result.fromShell.length > 0) {
    logHook(
      "warn",
      source,
      `Recovered ${result.fromShell.join(", ")} from the login shell and saved it to the env snapshot ` +
        `(the host launched this hook without it).`,
    );
  }

  if (result.missing.length > 0) {
    logHookError(
      source,
      `Missing required environment variable(s): ${result.missing.join(", ")}. ` +
        `Run \`npx code-session-memory install\` from a shell where they are exported, ` +
        `or \`npx code-session-memory config set-env OPENAI_API_KEY=sk-...\`.`,
    );
  }
}

/** Logs the outcome of a hook run so `status` can show that indexing is alive. */
export function logHookRun(source: string, message: string): void {
  logHook("info", source, message);
}

export { logHookError };
