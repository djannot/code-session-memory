/**
 * REST API route handlers for the web UI.
 *
 * Uses short-lived DB connections (open → query → close) per request,
 * matching the MCP server's pattern to avoid WAL locking issues.
 */

import { Router, Request, Response } from "express";
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
} from "../database";
import { createEmbedder } from "../embedder";
import { getStatus } from "../status";
import type { SessionSource } from "../types";

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
