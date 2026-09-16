/**
 * Runtime environment resolution for hooks and MCP servers.
 *
 * GUI-launched hosts (the Claude desktop app started by launchd on macOS,
 * Explorer/Start-menu launches on Windows, desktop-file launches on Linux)
 * hand their child processes a bare environment: no shell profile is sourced,
 * so `node` is often not on PATH and user-exported variables such as
 * OPENAI_API_KEY are absent. Hooks inherit that environment directly, so a
 * hook that works from a terminal-launched host fails silently in the GUI app.
 *
 * Two mechanisms fix this:
 *   1. Install time records the ABSOLUTE path of the node binary, so hook
 *      commands never depend on PATH.
 *   2. Install time snapshots the environment variables we need into
 *      ~/.config/code-session-memory/env.json (0600), and every entry point
 *      calls hydrateEnv() to merge that snapshot into process.env.
 *
 * If a snapshot is missing the API key (installed from an environment that
 * did not export it), hydrateEnv() falls back to asking the user's login
 * shell once and persists whatever it finds.
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { getConfigDir } from "./config";

// ---------------------------------------------------------------------------
// Which variables travel with the snapshot
// ---------------------------------------------------------------------------

/**
 * Environment variables the indexers / MCP server need and that a GUI-launched
 * host will not provide. Order matters only for display.
 */
export const SNAPSHOT_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "OPENAI_SUMMARY_MODEL",
  "CSM_BACKEND",
  "CSM_POSTGRES_URL",
  "CSM_POSTGRES_SSL",
  "OPENCODE_MEMORY_DB_PATH",
] as const;

/** Variables without which indexing cannot work at all. */
export const REQUIRED_ENV_KEYS = ["OPENAI_API_KEY"] as const;

/** Variables whose values must never be printed in full. */
const SECRET_ENV_KEYS = new Set(["OPENAI_API_KEY", "CSM_POSTGRES_URL"]);

/**
 * Snapshot key (underscore-prefixed, so it is never exported as a variable)
 * recording when a login-shell probe last came back empty. A Stop hook blocks
 * the host until it exits, so probing on every turn would add seconds to each
 * turn for a user who simply has no key configured.
 */
const PROBE_FAILED_AT = "_lastProbeFailedAt";

/** How long to wait before probing the login shell again after a failure. */
const PROBE_RETRY_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type EnvSnapshot = Record<string, string>;

// ---------------------------------------------------------------------------
// Snapshot file
// ---------------------------------------------------------------------------

export function getEnvFilePath(): string {
  return path.join(getConfigDir(), "env.json");
}

/** Reads the snapshot; returns {} when absent or unreadable. */
export function loadEnvSnapshot(): EnvSnapshot {
  try {
    const raw = fs.readFileSync(getEnvFilePath(), "utf8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: EnvSnapshot = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string" && value.length > 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Merges `values` into the snapshot file and writes it with 0600 permissions.
 * Existing keys that are not in `values` are preserved, so a re-install from a
 * shell that happens to be missing a variable never drops it.
 */
export function saveEnvSnapshot(values: EnvSnapshot): EnvSnapshot {
  const merged = { ...loadEnvSnapshot() };
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string" && value.length > 0) merged[key] = value;
  }

  // A newly supplied required variable means the previous probe failure is
  // stale: allow probing again if it ever goes missing.
  if (REQUIRED_ENV_KEYS.some((key) => values[key])) delete merged[PROBE_FAILED_AT];

  const filePath = getEnvFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  // writeFileSync only applies `mode` when creating the file — enforce it on
  // an existing one too, so an older world-readable snapshot gets tightened.
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best effort — Windows and some filesystems ignore chmod */
  }
  return merged;
}

/** Picks the snapshot-relevant variables out of the current environment. */
export function captureEnvFromProcess(env: NodeJS.ProcessEnv = process.env): EnvSnapshot {
  const out: EnvSnapshot = {};
  for (const key of SNAPSHOT_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim().length > 0) out[key] = value;
  }
  return out;
}

/** Masks a value for display: keeps a short prefix/suffix for recognisability. */
export function maskEnvValue(key: string, value: string): string {
  if (!SECRET_ENV_KEYS.has(key)) return value;
  if (key === "CSM_POSTGRES_URL") return value.replace(/:[^:@]*@/, ":***@");
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Login-shell probe (POSIX only)
// ---------------------------------------------------------------------------

const PROBE_BEGIN = "__CSM_ENV_BEGIN__";
const PROBE_END = "__CSM_ENV_END__";

/**
 * Asks the user's login shell for the given variables by sourcing their
 * profile. Returns only the variables that came back non-empty.
 *
 * Interactive (`-i`) is tried first because zsh/bash users usually export keys
 * from ~/.zshrc or ~/.bashrc, which a non-interactive login shell skips.
 * Never used on Windows, and always bounded by a timeout so a slow or
 * misbehaving profile cannot hang a Stop hook.
 */
export function probeLoginShellEnv(
  keys: readonly string[] = REQUIRED_ENV_KEYS,
  options: { timeoutMs?: number; shell?: string } = {},
): EnvSnapshot {
  if (process.platform === "win32") return {};
  const shell = options.shell ?? process.env.SHELL ?? "/bin/sh";
  if (!shell) return {};

  const emit = keys
    .map((key) => `printf '%s=%s\\n' ${key} "$${key}"`)
    .join("; ");
  const script = `printf '${PROBE_BEGIN}\\n'; ${emit}; printf '${PROBE_END}\\n'`;

  for (const flags of [["-lic"], ["-lc"]]) {
    let stdout: string;
    try {
      const result = spawnSync(shell, [...flags, script], {
        encoding: "utf8",
        timeout: options.timeoutMs ?? 3000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      stdout = result.stdout ?? "";
    } catch {
      continue;
    }

    const found = parseProbeOutput(stdout, keys);
    if (Object.keys(found).length > 0) return found;
  }
  return {};
}

/** Extracts KEY=value pairs between the probe markers. */
function parseProbeOutput(stdout: string, keys: readonly string[]): EnvSnapshot {
  const begin = stdout.lastIndexOf(PROBE_BEGIN);
  const end = stdout.lastIndexOf(PROBE_END);
  if (begin === -1 || end === -1 || end < begin) return {};

  const body = stdout.slice(begin + PROBE_BEGIN.length, end);
  const wanted = new Set(keys);
  const out: EnvSnapshot = {};
  for (const line of body.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (wanted.has(key) && value.length > 0) out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// hydrateEnv — called by every entry point
// ---------------------------------------------------------------------------

/** True when no probe has failed recently. */
function probeIsDue(snapshot: EnvSnapshot): boolean {
  const last = Date.parse(snapshot[PROBE_FAILED_AT] ?? "");
  if (Number.isNaN(last)) return true;
  return Date.now() - last > PROBE_RETRY_INTERVAL_MS;
}

export interface HydrateResult {
  /** Variables that were added to process.env from the snapshot. */
  fromSnapshot: string[];
  /** Variables that were recovered by probing the login shell. */
  fromShell: string[];
  /** Required variables that are still missing afterwards. */
  missing: string[];
}

/**
 * Fills gaps in process.env from the snapshot file, then (only if a required
 * variable is still missing) from the user's login shell.
 *
 * Variables already present in process.env always win — a host that does
 * provide a proper environment keeps full control.
 */
export function hydrateEnv(options: { probeShell?: boolean } = {}): HydrateResult {
  const fromSnapshot: string[] = [];
  const fromShell: string[] = [];

  const snapshot = loadEnvSnapshot();
  for (const key of SNAPSHOT_ENV_KEYS) {
    const value = snapshot[key];
    if (!value) continue;
    const current = process.env[key];
    if (typeof current === "string" && current.length > 0) continue;
    process.env[key] = value;
    fromSnapshot.push(key);
  }

  let missing = REQUIRED_ENV_KEYS.filter((key) => !process.env[key]);

  if (missing.length > 0 && options.probeShell !== false && probeIsDue(snapshot)) {
    const probed = probeLoginShellEnv(missing);
    try {
      if (Object.keys(probed).length > 0) {
        // Persist so the next hook run does not have to spawn a shell.
        saveEnvSnapshot(probed);
      } else {
        // Remember the failure so the next turns are not delayed by a probe
        // that has nothing to find.
        saveEnvSnapshot({ [PROBE_FAILED_AT]: new Date().toISOString() });
      }
    } catch {
      /* best effort */
    }
    for (const [key, value] of Object.entries(probed)) {
      process.env[key] = value;
      fromShell.push(key);
    }
    missing = REQUIRED_ENV_KEYS.filter((key) => !process.env[key]);
  }

  return { fromSnapshot, fromShell, missing: [...missing] };
}

// ---------------------------------------------------------------------------
// Node executable resolution (install time)
// ---------------------------------------------------------------------------

function looksLikeNode(execPath: string): boolean {
  return /^node(\.exe)?$/i.test(path.basename(execPath));
}

/**
 * Absolute path of a node binary to bake into hook commands and MCP configs.
 *
 * Prefers the interpreter running the installer (guaranteed to exist and to
 * match the version the user installed with). If the installer is running
 * under something else (bun, tsx via a different runtime, an Electron host),
 * asks the login shell for `node`, and only then falls back to the bare
 * command — which is what fails under a GUI-launched host, so callers should
 * treat `"node"` as "unresolved".
 */
export function resolveNodeExecutable(): string {
  if (looksLikeNode(process.execPath) && fs.existsSync(process.execPath)) {
    return process.execPath;
  }

  const lookup = process.platform === "win32" ? "where node" : "command -v node";
  const shell = process.platform === "win32"
    ? process.env.COMSPEC ?? "cmd.exe"
    : process.env.SHELL ?? "/bin/sh";
  const args = process.platform === "win32" ? ["/c", lookup] : ["-lic", lookup];

  try {
    const result = spawnSync(shell, args, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = (result.stdout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && path.isAbsolute(line) && fs.existsSync(line));
    if (first) return first;
  } catch {
    /* fall through */
  }

  return "node";
}

/** True when the recorded node path is absolute and still present on disk. */
export function isResolvedNodePath(nodePath: string): boolean {
  return path.isAbsolute(nodePath) && fs.existsSync(nodePath);
}

/**
 * Quotes a path for embedding in a hook command string. Double quotes work in
 * POSIX shells and in cmd.exe; paths containing a double quote are rejected
 * rather than mis-quoted.
 */
export function quoteForShell(value: string): string {
  if (value.includes('"')) {
    throw new Error(`Refusing to build a shell command from a path containing a quote: ${value}`);
  }
  return `"${value}"`;
}

/** Builds the `"<node>" "<script>"` command string used by hook configs. */
export function buildNodeCommand(nodePath: string, scriptPath: string): string {
  return `${quoteForShell(nodePath)} ${quoteForShell(scriptPath)}`;
}
