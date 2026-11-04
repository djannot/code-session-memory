/**
 * Transcript path discovery — locates the on-disk transcript of an indexed
 * session when sessions_meta has no (or a stale) transcript_path.
 * Shared by the web re-index endpoints and the analytics backfill command.
 */

import fs from "fs";
import path from "path";
import os from "os";
import type { SessionMeta } from "./types";

export function discoverClaudeTranscript(sessionId: string): string | null {
  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  if (!fs.existsSync(claudeDir)) return null;
  try {
    for (const project of fs.readdirSync(claudeDir)) {
      const candidate = path.join(claudeDir, project, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* ignore */ }
  return null;
}

export function discoverCodexTranscript(threadId: string): string | null {
  const sessionsDir = path.join(
    process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"),
    "sessions",
  );
  if (!fs.existsSync(sessionsDir)) return null;

  const matches: { path: string; mtime: number }[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) {
        let mtime = 0;
        try { mtime = fs.statSync(fullPath).mtimeMs; } catch { /* ignore */ }
        matches.push({ path: fullPath, mtime });
      }
    }
  }
  walk(sessionsDir);
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0].path;
}

export function discoverGeminiTranscript(sessionId: string): string | null {
  const tmpRoot = path.join(
    process.env.GEMINI_CONFIG_DIR ?? path.join(os.homedir(), ".gemini"),
    "tmp",
  );
  if (!fs.existsSync(tmpRoot)) return null;

  const files: { path: string; mtime: number }[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && entry.name.startsWith("session-") && entry.name.endsWith(".json")) {
        let mtime = 0;
        try { mtime = fs.statSync(fullPath).mtimeMs; } catch { /* ignore */ }
        files.push({ path: fullPath, mtime });
      }
    }
  }
  walk(tmpRoot);
  files.sort((a, b) => b.mtime - a.mtime);

  for (const { path: filePath } of files.slice(0, 200)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        sessionId?: string; session_id?: string;
      };
      if ((parsed.sessionId ?? parsed.session_id) === sessionId) return filePath;
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Antigravity keeps one transcript per conversation, under the surface
 * directory that produced it: `antigravity` (the 2.x app), `antigravity-ide`
 * (the editor) or `antigravity-cli`. All three live inside the Gemini config
 * directory, which Antigravity shares with Gemini CLI.
 */
export function discoverAntigravityTranscript(conversationId: string): string | null {
  if (!conversationId.trim()) return null;

  const geminiDir = process.env.GEMINI_CONFIG_DIR ?? path.join(os.homedir(), ".gemini");
  const surfaces = ["antigravity", "antigravity-ide", "antigravity-cli"];

  const matches: { path: string; mtime: number }[] = [];
  for (const surface of surfaces) {
    const candidate = path.join(
      geminiDir,
      surface,
      "brain",
      conversationId,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    if (!fs.existsSync(candidate)) continue;
    let mtime = 0;
    try { mtime = fs.statSync(candidate).mtimeMs; } catch { /* ignore */ }
    matches.push({ path: candidate, mtime });
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => b.mtime - a.mtime);
  return matches[0].path;
}

export function resolveTranscriptPath(meta: SessionMeta): string | null {
  if (meta.transcript_path && fs.existsSync(meta.transcript_path)) {
    return meta.transcript_path;
  }
  switch (meta.source) {
    case "claude-code": return discoverClaudeTranscript(meta.session_id);
    case "codex": return discoverCodexTranscript(meta.session_id);
    case "gemini-cli": return discoverGeminiTranscript(meta.session_id);
    case "antigravity": return discoverAntigravityTranscript(meta.session_id);
    default: return null;
  }
}
