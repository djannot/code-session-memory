/**
 * REST API route handlers for the web UI.
 *
 * Uses short-lived DB connections (open → query → close) per request,
 * matching the MCP server's pattern to avoid WAL locking issues.
 */

import { Router, Request, Response } from "express";
import fs from "fs";
import path from "path";
import os from "os";
import {
  resolveDbPath,
  openDatabase,
  queryByEmbedding,
  queryHybrid,
  getChunksByUrl,
  getSessionContext,
  listSessions,
  getSessionChunksOrdered,
  deleteSession,
  deleteSessionsOlderThan,
  getToolUsageStats,
  getMessageStats,
  getOverviewStats,
  getSessionAnalytics,
  getSessionMeta,
  upsertSessionMeta,
} from "../database";
import { createEmbedder } from "../embedder";
import { indexNewMessages } from "../indexer";
import { getStatus } from "../status";
import type { SessionSource, SessionMeta, AnalyticsFilter } from "../types";
import { parseTranscript, deriveSessionTitle } from "../transcript-to-messages";
import { cursorTranscriptToMessages } from "../cursor-transcript-to-messages";
import { parseVscodeTranscript } from "../vscode-transcript-to-messages";
import { codexSessionToMessages, deriveCodexSessionTitle } from "../codex-session-to-messages";
import { geminiSessionToMessages, deriveGeminiSessionTitle } from "../gemini-session-to-messages";

// ---------------------------------------------------------------------------
// DB helper
// ---------------------------------------------------------------------------

function withDb<T>(fn: (db: ReturnType<typeof openDatabase>) => T): T {
  const dbPath = resolveDbPath();
  const db = openDatabase({ dbPath });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Date helper
// ---------------------------------------------------------------------------

function parseDateMs(value: string, boundary: "start" | "end"): number | null {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const ms = Date.parse(value);
  if (isNaN(ms)) return null;
  if (dateOnly && boundary === "end") {
    return ms + 24 * 60 * 60 * 1000 - 1;
  }
  return ms;
}

// ---------------------------------------------------------------------------
// Valid sources
// ---------------------------------------------------------------------------

const VALID_SOURCES = new Set<string>([
  "opencode", "claude-code", "cursor", "vscode", "codex", "gemini-cli",
]);

const VALID_SECTIONS = new Set<string>(["user", "assistant", "tool"]);

function parseAnalyticsFilter(req: Request): AnalyticsFilter {
  const filter: AnalyticsFilter = {};
  if (typeof req.query.source === "string" && VALID_SOURCES.has(req.query.source)) {
    filter.source = req.query.source as SessionSource;
  }
  if (typeof req.query.project === "string" && req.query.project) {
    filter.project = req.query.project;
  }
  if (typeof req.query.from === "string" && req.query.from) {
    const ms = parseDateMs(req.query.from, "start");
    if (ms !== null) filter.fromMs = ms;
  }
  if (typeof req.query.to === "string" && req.query.to) {
    const ms = parseDateMs(req.query.to, "end");
    if (ms !== null) filter.toMs = ms;
  }
  return filter;
}

// ---------------------------------------------------------------------------
// Transcript path discovery (for re-indexing sessions without a stored path)
// ---------------------------------------------------------------------------

function discoverClaudeTranscript(sessionId: string): string | null {
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

function discoverCodexTranscript(threadId: string): string | null {
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

function discoverGeminiTranscript(sessionId: string): string | null {
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

function resolveTranscriptPath(meta: SessionMeta): string | null {
  // Try stored path first
  if (meta.transcript_path && fs.existsSync(meta.transcript_path)) {
    return meta.transcript_path;
  }
  // Fall back to source-specific discovery
  switch (meta.source) {
    case "claude-code": return discoverClaudeTranscript(meta.session_id);
    case "codex": return discoverCodexTranscript(meta.session_id);
    case "gemini-cli": return discoverGeminiTranscript(meta.session_id);
    default: return null;
  }
}

interface ReindexCheckResult {
  ready: Array<{ id: string; title: string; source: SessionSource }>;
  skipped: Array<{ id: string; title: string; source: SessionSource; reason: string }>;
}

function checkReindexability(
  db: ReturnType<typeof openDatabase>,
  ids: string[],
): ReindexCheckResult {
  const result: ReindexCheckResult = { ready: [], skipped: [] };

  for (const id of ids) {
    const meta = getSessionMeta(db, id);
    if (!meta) {
      result.skipped.push({ id, title: id, source: "opencode", reason: "Session not found in database" });
      continue;
    }
    const info = { id, title: meta.session_title, source: meta.source };

    if (meta.source === "opencode") {
      result.skipped.push({ ...info, reason: "OpenCode sessions use internal DB, cannot reindex from transcript" });
      continue;
    }

    const transcriptPath = resolveTranscriptPath(meta);
    if (!transcriptPath) {
      const hint = meta.source === "cursor" || meta.source === "vscode"
        ? "Transcript file not available (temporary files are deleted after the session)"
        : "Transcript file not found";
      result.skipped.push({ ...info, reason: hint });
      continue;
    }

    result.ready.push(info);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function createApiRouter(): Router {
  const router = Router();

  // POST /api/search — hybrid semantic + keyword search
  router.post("/search", async (req: Request, res: Response) => {
    try {
      const { queryText, source, limit, fromDate, toDate, sectionFilter: rawSection, hybrid } = req.body;

      if (!queryText || typeof queryText !== "string") {
        res.status(400).json({ error: "queryText is required" });
        return;
      }

      if (!process.env.OPENAI_API_KEY) {
        res.status(500).json({ error: "OPENAI_API_KEY environment variable is not set on the server" });
        return;
      }

      const sourceFilter = source && VALID_SOURCES.has(source) ? source as SessionSource : undefined;
      const sectionFilter = rawSection && VALID_SECTIONS.has(rawSection) ? rawSection as string : undefined;
      const topK = typeof limit === "number" && limit > 0 ? Math.min(limit, 50) : 5;

      let fromMs: number | undefined;
      let toMs: number | undefined;
      if (typeof fromDate === "string" && fromDate) {
        fromMs = parseDateMs(fromDate, "start") ?? undefined;
      }
      if (typeof toDate === "string" && toDate) {
        toMs = parseDateMs(toDate, "end") ?? undefined;
      }

      const embedder = createEmbedder();
      const embedding = await embedder.embedText(queryText);

      const useHybrid = hybrid === true;
      const results = withDb((db) =>
        useHybrid
          ? queryHybrid(db, embedding, queryText, topK, undefined, sourceFilter, fromMs, toMs, sectionFilter)
          : queryByEmbedding(db, embedding, topK, undefined, sourceFilter, fromMs, toMs, sectionFilter)
      );

      res.json({ results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/chunks — fetch chunks by URL with optional index range (for context preview)
  router.get("/chunks", (req: Request, res: Response) => {
    try {
      const url = typeof req.query.url === "string" ? req.query.url : "";
      if (!url) {
        res.status(400).json({ error: "url query parameter is required" });
        return;
      }

      const startIndex = typeof req.query.startIndex === "string" ? parseInt(req.query.startIndex, 10) : undefined;
      const endIndex = typeof req.query.endIndex === "string" ? parseInt(req.query.endIndex, 10) : undefined;

      const chunks = withDb((db) => getChunksByUrl(db, url, startIndex, endIndex));
      res.json({ chunks });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/context — fetch session-level context around a specific chunk
  router.get("/context", (req: Request, res: Response) => {
    try {
      const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : "";
      const chunkId = typeof req.query.chunkId === "string" ? req.query.chunkId : "";
      if (!sessionId || !chunkId) {
        res.status(400).json({ error: "sessionId and chunkId query parameters are required" });
        return;
      }

      const windowSize = typeof req.query.window === "string" ? parseInt(req.query.window, 10) : 1;

      const chunks = withDb((db) => getSessionContext(db, sessionId, chunkId, windowSize));
      res.json({ chunks });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/sessions — list sessions
  router.get("/sessions", (req: Request, res: Response) => {
    try {
      const source = typeof req.query.source === "string" && VALID_SOURCES.has(req.query.source)
        ? req.query.source as SessionSource
        : undefined;

      let fromDate: number | undefined;
      let toDate: number | undefined;
      if (typeof req.query.from === "string" && req.query.from) {
        fromDate = parseDateMs(req.query.from, "start") ?? undefined;
      }
      if (typeof req.query.to === "string" && req.query.to) {
        toDate = parseDateMs(req.query.to, "end") ?? undefined;
      }

      const sessions = withDb((db) => listSessions(db, { source, fromDate, toDate }));
      res.json({ sessions });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/sessions/:id — session detail with chunks
  router.get("/sessions/:id", (req: Request, res: Response) => {
    try {
      const sessionId = String(req.params.id);
      const { session, chunks } = withDb((db) => {
        const rows = listSessions(db, {});
        const session = rows.find((s) => s.session_id === sessionId) ?? null;
        const chunks = getSessionChunksOrdered(db, sessionId);
        return { session, chunks };
      });

      if (!session && chunks.length === 0) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      res.json({ session, chunks });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // DELETE /api/sessions/:id — delete a session
  router.delete("/sessions/:id", (req: Request, res: Response) => {
    try {
      const sessionId = String(req.params.id);
      const deleted = withDb((db) => deleteSession(db, sessionId));
      res.json({ deleted });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // POST /api/sessions/bulk-delete — delete multiple sessions at once
  router.post("/sessions/bulk-delete", (req: Request, res: Response) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id: unknown) => typeof id === "string")) {
        res.status(400).json({ error: "ids must be a non-empty array of strings" });
        return;
      }

      const deleted = withDb((db) => {
        let total = 0;
        for (const id of ids) {
          total += deleteSession(db, id);
        }
        return total;
      });

      res.json({ deleted });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // POST /api/sessions/reindex-check — dry run: which sessions can be reindexed?
  router.post("/sessions/reindex-check", (req: Request, res: Response) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id: unknown) => typeof id === "string")) {
        res.status(400).json({ error: "ids must be a non-empty array of strings" });
        return;
      }

      const result = withDb((db) => checkReindexability(db, ids));
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // POST /api/sessions/bulk-reindex — reindex sessions from their transcript files
  router.post("/sessions/bulk-reindex", async (req: Request, res: Response) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id: unknown) => typeof id === "string")) {
        res.status(400).json({ error: "ids must be a non-empty array of strings" });
        return;
      }

      if (!process.env.OPENAI_API_KEY) {
        res.status(500).json({ error: "OPENAI_API_KEY environment variable is not set — required for embedding" });
        return;
      }

      let reindexed = 0;
      const failed: Array<{ id: string; reason: string }> = [];

      // Process sequentially to avoid overwhelming the embedding API
      for (const id of ids) {
        try {
          const dbPath = resolveDbPath();
          const db = openDatabase({ dbPath });
          try {
            const meta = getSessionMeta(db, id);
            if (!meta) { failed.push({ id, reason: "Session not found" }); continue; }

            const transcriptPath = resolveTranscriptPath(meta);
            if (!transcriptPath) { failed.push({ id, reason: "Transcript not available" }); continue; }

            // Parse transcript based on source
            let messages;
            let title = meta.session_title;
            switch (meta.source) {
              case "claude-code":
                messages = parseTranscript(transcriptPath);
                if (!title) title = deriveSessionTitle(messages);
                break;
              case "cursor":
                messages = cursorTranscriptToMessages(transcriptPath, id);
                break;
              case "vscode":
                messages = parseVscodeTranscript(transcriptPath);
                break;
              case "codex":
                messages = codexSessionToMessages(transcriptPath);
                if (!title) title = deriveCodexSessionTitle(messages);
                break;
              case "gemini-cli":
                messages = geminiSessionToMessages(transcriptPath);
                if (!title) title = deriveGeminiSessionTitle(messages, id);
                break;
              default:
                failed.push({ id, reason: `Source "${meta.source}" cannot be reindexed` });
                continue;
            }

            if (!messages || messages.length === 0) {
              failed.push({ id, reason: "Transcript parsed but produced no messages" });
              continue;
            }

            // Safe: parse succeeded, now delete old data and re-index
            deleteSession(db, id);

            const session = { id, title, directory: meta.project };
            await indexNewMessages(db, session, messages, meta.source, { transcriptPath });

            reindexed++;
          } finally {
            db.close();
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failed.push({ id, reason: msg });
        }
      }

      res.json({ reindexed, failed });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // POST /api/sessions/purge — purge old sessions
  router.post("/sessions/purge", (req: Request, res: Response) => {
    try {
      const { days } = req.body;
      if (typeof days !== "number" || days <= 0) {
        res.status(400).json({ error: "days must be a positive number" });
        return;
      }

      const DAY_MS = 86400 * 1000;
      const cutoff = Date.now() - days * DAY_MS;
      const result = withDb((db) => deleteSessionsOlderThan(db, cutoff));
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // -------------------------------------------------------------------------
  // Analytics endpoints
  // -------------------------------------------------------------------------

  // GET /api/analytics/overview — aggregate totals
  router.get("/analytics/overview", (req: Request, res: Response) => {
    try {
      const filter = parseAnalyticsFilter(req);
      const stats = withDb((db) => getOverviewStats(db, filter));
      res.json(stats);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/analytics/tools — tool usage stats
  router.get("/analytics/tools", (req: Request, res: Response) => {
    try {
      const filter = parseAnalyticsFilter(req);
      const stats = withDb((db) => getToolUsageStats(db, filter));
      res.json({ tools: stats });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/analytics/messages — message counts by role
  router.get("/analytics/messages", (req: Request, res: Response) => {
    try {
      const filter = parseAnalyticsFilter(req);
      const stats = withDb((db) => getMessageStats(db, filter));
      res.json({ messages: stats });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/analytics/session/:id — per-session analytics
  router.get("/analytics/session/:id", (req: Request, res: Response) => {
    try {
      const sessionId = String(req.params.id);
      const analytics = withDb((db) => getSessionAnalytics(db, sessionId));
      if (!analytics) {
        res.status(404).json({ error: "No analytics data for this session" });
        return;
      }
      res.json(analytics);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/status — DB stats + tool installation status
  router.get("/status", (_req: Request, res: Response) => {
    try {
      const status = getStatus();
      res.json(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
