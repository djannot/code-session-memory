import { Router, Request, Response } from "express";
import { resolveDbPath, openDatabase, queryByEmbedding, getMapChunksByIds } from "../database";
import { createEmbedder } from "../embedder";
import {
  computeCoordinates,
  getMapStatus,
  buildMapOverview,
  buildVisualizationForSearch,
  buildNeighborVisualization,
} from "./map-service";
import type { SessionSource } from "../types";

// ---------------------------------------------------------------------------
// DB helper (same pattern as api-routes.ts)
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

const VALID_SOURCES = new Set<string>([
  "opencode", "claude-code", "cursor", "vscode", "codex", "gemini-cli",
]);

const MAP_SAMPLE_CAP = 2000;
const MAP_NEIGHBOR_CAP = 50;

const VALID_SECTIONS = new Set<string>(["user", "assistant", "tool"]);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function createMapRouter(): Router {
  const router = Router();

  // GET /api/map/status — check if coordinates are computed
  router.get("/status", (_req: Request, res: Response) => {
    try {
      const status = withDb((db) => getMapStatus(db));
      res.json(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // POST /api/map/compute — trigger UMAP coordinate computation
  router.post("/compute", async (_req: Request, res: Response) => {
    try {
      const dbPath = resolveDbPath();
      const db = openDatabase({ dbPath });
      try {
        const result = await computeCoordinates(db);
        res.json({ success: true, count: result.count });
      } finally {
        db.close();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // POST /api/map — map overview (random sample of nodes)
  router.post("/", (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.body?.limit ?? MAP_SAMPLE_CAP), MAP_SAMPLE_CAP);
      const sectionFilter = req.body?.sectionFilter && VALID_SECTIONS.has(req.body.sectionFilter)
        ? req.body.sectionFilter as string : undefined;
      const minContentLength = typeof req.body?.minContentLength === "number" && req.body.minContentLength > 0
        ? req.body.minContentLength : undefined;
      const visualization = withDb((db) => buildMapOverview(db, limit, sectionFilter, minContentLength));
      res.json({ visualization });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // POST /api/map/search — semantic search with visualization
  router.post("/search", async (req: Request, res: Response) => {
    try {
      const { queryText, source, limit, sectionFilter: rawSection, minContentLength: rawMinLen } = req.body;

      if (!queryText || typeof queryText !== "string") {
        res.status(400).json({ error: "queryText is required" });
        return;
      }

      if (!process.env.OPENAI_API_KEY) {
        res.status(500).json({ error: "OPENAI_API_KEY environment variable is not set" });
        return;
      }

      const sourceFilter = source && VALID_SOURCES.has(source) ? source as SessionSource : undefined;
      const topK = typeof limit === "number" && limit > 0 ? Math.min(limit, 50) : 10;
      const sectionFilter = rawSection && VALID_SECTIONS.has(rawSection) ? rawSection as string : undefined;
      const minContentLength = typeof rawMinLen === "number" && rawMinLen > 0 ? rawMinLen : undefined;

      const embedder = createEmbedder();
      const embedding = await embedder.embedText(queryText);

      const dbPath = resolveDbPath();
      const db = openDatabase({ dbPath });
      try {
        const results = queryByEmbedding(db, embedding, topK, undefined, sourceFilter, undefined, undefined, sectionFilter, minContentLength);
        const searchResults = results.map((r) => ({
          chunk_id: r.chunk_id,
          distance: r.distance,
        }));
        const visualization = buildVisualizationForSearch(db, searchResults, undefined, sectionFilter, minContentLength);
        res.json({ results, visualization });
      } finally {
        db.close();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // POST /api/map/neighbors — neighbors for a specific chunk
  router.post("/neighbors", (req: Request, res: Response) => {
    try {
      const chunkId = req.body?.chunk_id as string;
      if (!chunkId) {
        res.status(400).json({ error: "chunk_id is required" });
        return;
      }
      const limit = Math.min(Number(req.body?.limit ?? MAP_NEIGHBOR_CAP), MAP_NEIGHBOR_CAP);
      const visualization = withDb((db) => buildNeighborVisualization(db, chunkId, limit));
      if (!visualization) {
        res.status(404).json({ error: "Chunk not found" });
        return;
      }
      res.json({ visualization });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // GET /api/map/chunk/:id — fetch chunk content by ID
  router.get("/chunk/:id", (req: Request, res: Response) => {
    try {
      const chunkId = String(req.params.id);
      const rows = withDb((db) => getMapChunksByIds(db, [chunkId]));
      if (rows.length === 0) {
        res.status(404).json({ error: "Chunk not found" });
        return;
      }
      res.json({ content: rows[0].content });
    } catch (err) {
      console.error("Chunk content error:", err);
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  return router;
}
