/**
 * Hook logging.
 *
 * Hosts discard hook stderr (Claude Code, Cursor, VS Code and Codex all do),
 * so a hook that crashes leaves no trace: sessions silently stop being
 * indexed. Every hook entry point therefore appends one line per run to
 * ~/.config/code-session-memory/logs/hook.log, and `status` surfaces the most
 * recent errors.
 */

import fs from "fs";
import path from "path";
import { getConfigDir } from "./config";

/** Rotate once the log passes this size, keeping a single previous file. */
const MAX_LOG_BYTES = 1024 * 1024;

export type HookLogLevel = "info" | "warn" | "error";

export function getHookLogPath(): string {
  return path.join(getConfigDir(), "logs", "hook.log");
}

function rotateIfNeeded(logPath: string): void {
  try {
    const { size } = fs.statSync(logPath);
    if (size < MAX_LOG_BYTES) return;
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    /* no log yet, or rotation failed — either way, keep appending */
  }
}

/**
 * Appends one line to the hook log. Never throws: a logging failure must not
 * take down an indexing run.
 */
export function logHook(level: HookLogLevel, source: string, message: string): void {
  const line = `${new Date().toISOString()} [${level}] [${source}] ${message.replace(/\s*\n\s*/g, " ")}\n`;
  try {
    const logPath = getHookLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    rotateIfNeeded(logPath);
    fs.appendFileSync(logPath, line, "utf8");
  } catch {
    /* best effort */
  }
}

/**
 * Logs an error and mirrors it to stderr (useful when the host does show it,
 * e.g. when a hook is run by hand from a terminal).
 */
export function logHookError(source: string, message: string): void {
  logHook("error", source, message);
  try {
    process.stderr.write(`[code-session-memory] ${message}\n`);
  } catch {
    /* stderr can be closed */
  }
}

export interface HookLogEntry {
  timestamp: string;
  level: HookLogLevel | string;
  source: string;
  message: string;
  raw: string;
}

function parseLine(raw: string): HookLogEntry | null {
  const match = /^(\S+) \[(\w+)\] \[([^\]]+)\] ([\s\S]*)$/.exec(raw);
  if (!match) return null;
  return { timestamp: match[1], level: match[2], source: match[3], message: match[4], raw };
}

/** Returns the last `limit` log entries, newest last. */
export function readHookLog(limit = 20, level?: HookLogLevel): HookLogEntry[] {
  let content: string;
  try {
    content = fs.readFileSync(getHookLogPath(), "utf8");
  } catch {
    return [];
  }
  const entries = content
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(parseLine)
    .filter((entry): entry is HookLogEntry => entry !== null)
    .filter((entry) => (level ? entry.level === level : true));
  return entries.slice(-limit);
}
