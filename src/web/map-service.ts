import { Worker } from "worker_threads";
import path from "path";
import type { Database, MapChunkRow } from "../database";
import {
  getAllEmbeddingsWithIds,
  upsertChunkCoords,
  clearChunkCoords,
  getChunkCoordsCount,
  getTotalChunkCount,
  getMapOverviewChunks,
  getMapChunksByIds,
  getEmbeddingByChunkId,
  getKnnNeighbors,
} from "../database";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VisualizationPoint {
  id: string;
  x: number;
  y: number;
  score: number | null;
  type: "result" | "neighbor" | "map" | "focus";
  url: string;
  session_id: string;
  session_title: string;
  project: string;
  source: string;
  section: string;
  heading_hierarchy: string;
  chunk_index: number;
  total_chunks: number;
  keywords: string[];
}

export interface VisualizationPayload {
  points: VisualizationPoint[];
  center: { x: number; y: number };
  focusId?: string;
}

export interface MapStatus {
  coordsCount: number;
  totalChunks: number;
  ready: boolean;
  computing: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAP_SAMPLE_LIMIT = 600;
const MAP_NEIGHBOR_LIMIT = 10;
const COORD_SCALE = 320;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let isComputing = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeEmbedding(raw: Buffer | Float32Array | number[] | null | undefined): Float32Array | null {
  if (!raw) return null;
  if (raw instanceof Float32Array) return raw;
  if (Array.isArray(raw)) return new Float32Array(raw);
  if (Buffer.isBuffer(raw)) {
    return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  }
  return null;
}

function parseHeadingHierarchy(raw: string): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(Boolean).join(" > ");
  } catch {
    return raw;
  }
  return raw;
}

function extractKeywords(content: string, max = 3): string[] {
  if (!content) return [];
  const stopwords = new Set([
    "the", "and", "for", "with", "that", "this", "from", "into", "your", "you", "are",
    "was", "were", "have", "has", "had", "not", "but", "can", "will", "all", "any",
    "its", "our", "they", "their", "them", "using", "use", "used", "over", "more",
    "also", "such", "than", "then", "when", "what", "where", "which", "who", "how",
  ]);
  const tokens = (content.toLowerCase().match(/[a-z0-9]{3,}/g) || [])
    .filter((t) => !stopwords.has(t));
  const counts = new Map<string, number>();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([t]) => t);
}

function makePoint(row: MapChunkRow, type: VisualizationPoint["type"], score: number | null): VisualizationPoint {
  return {
    id: row.chunk_id,
    x: (row.x ?? 0) * COORD_SCALE,
    y: (row.y ?? 0) * COORD_SCALE,
    score,
    type,
    url: row.url,
    session_id: row.session_id,
    session_title: row.session_title,
    project: row.project,
    source: row.source,
    section: row.section,
    heading_hierarchy: parseHeadingHierarchy(row.heading_hierarchy),
    chunk_index: Number(row.chunk_index),
    total_chunks: Number(row.total_chunks),
    keywords: extractKeywords(row.content),
  };
}

// ---------------------------------------------------------------------------
// Coordinate computation (UMAP)
// ---------------------------------------------------------------------------

export async function computeCoordinates(db: Database): Promise<{ count: number }> {
  if (isComputing) throw new Error("Coordinate computation already in progress");
  isComputing = true;

  try {
    const rows = getAllEmbeddingsWithIds(db);
    if (rows.length === 0) {
      clearChunkCoords(db);
      return { count: 0 };
    }

    const chunkIds: string[] = [];
    const embeddings: number[][] = [];

    for (const row of rows) {
      const emb = normalizeEmbedding(row.embedding);
      if (!emb) continue;
      chunkIds.push(row.chunk_id);
      embeddings.push(Array.from(emb));
    }

    if (embeddings.length === 0) {
      return { count: 0 };
    }

    const workerPath = path.join(__dirname, "..", "umap-worker.js");
    const coords = await new Promise<Array<{ x: number; y: number }>>((resolve, reject) => {
      const worker = new Worker(workerPath);
      worker.on("message", (msg) => {
        worker.terminate();
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.coords);
      });
      worker.on("error", (err) => {
        worker.terminate();
        reject(err);
      });
      worker.postMessage({ embeddings });
    });

    clearChunkCoords(db);
    const coordRows = chunkIds.map((id, i) => ({
      chunkId: id,
      x: coords[i]?.x ?? 0,
      y: coords[i]?.y ?? 0,
    }));
    upsertChunkCoords(db, coordRows);

    return { count: coordRows.length };
  } finally {
    isComputing = false;
  }
}

// ---------------------------------------------------------------------------
// Map status
// ---------------------------------------------------------------------------

export function getMapStatus(db: Database): MapStatus {
  const coordsCount = getChunkCoordsCount(db);
  const totalChunks = getTotalChunkCount(db);
  return {
    coordsCount,
    totalChunks,
    ready: coordsCount > 0 && coordsCount >= totalChunks * 0.9,
    computing: isComputing,
  };
}

// ---------------------------------------------------------------------------
// Map overview (no search)
// ---------------------------------------------------------------------------

export function buildMapOverview(
  db: Database,
  limit = MAP_SAMPLE_LIMIT,
  sectionFilter?: string,
  minContentLength?: number,
): VisualizationPayload {
  const rows = getMapOverviewChunks(db, limit, sectionFilter, minContentLength);
  const points = rows.map((r) => makePoint(r, "map", null));
  const center = points[0] ? { x: points[0].x, y: points[0].y } : { x: 0, y: 0 };
  return { points, center };
}

// ---------------------------------------------------------------------------
// Search visualization
// ---------------------------------------------------------------------------

export function buildVisualizationForSearch(
  db: Database,
  results: Array<{ chunk_id: string; rrf_score?: number; distance?: number }>,
  sampleLimit = MAP_SAMPLE_LIMIT,
  sectionFilter?: string,
  minContentLength?: number,
): VisualizationPayload {
  const topResults = results.slice(0, 5);
  const resultIds = topResults.map((r) => r.chunk_id);
  const resultScores = new Map<string, number>();
  topResults.forEach((r) => {
    const score = r.rrf_score ?? (r.distance != null ? 1 / (1 + r.distance) : 0.5);
    resultScores.set(r.chunk_id, score);
  });

  // Find neighbors of result chunks
  const neighborScores = new Map<string, number>();
  const neighborIds: string[] = [];

  for (const result of topResults) {
    const rawEmb = getEmbeddingByChunkId(db, result.chunk_id);
    const emb = normalizeEmbedding(rawEmb);
    if (!emb) continue;
    const neighbors = getKnnNeighbors(db, emb, MAP_NEIGHBOR_LIMIT + 1);
    for (const n of neighbors) {
      if (n.chunk_id === result.chunk_id) continue;
      if (!neighborScores.has(n.chunk_id)) neighborIds.push(n.chunk_id);
      neighborScores.set(n.chunk_id, 1 / (1 + (n.distance ?? 0)));
    }
  }

  const uniqueNeighborIds = Array.from(new Set(neighborIds));
  const allIds = [...resultIds, ...uniqueNeighborIds];
  const rowMap = new Map<string, MapChunkRow>();
  getMapChunksByIds(db, allIds).forEach((r) => rowMap.set(r.chunk_id, r));

  const points: VisualizationPoint[] = [];
  for (const id of resultIds) {
    const row = rowMap.get(id);
    if (row) points.push(makePoint(row, "result", resultScores.get(id) ?? null));
  }
  for (const id of uniqueNeighborIds) {
    const row = rowMap.get(id);
    if (row) points.push(makePoint(row, "neighbor", neighborScores.get(id) ?? null));
  }

  // Add background map nodes
  const excludeIds = new Set(points.map((p) => p.id));
  const sampleRows = getMapOverviewChunks(db, sampleLimit, sectionFilter, minContentLength);
  for (const row of sampleRows) {
    if (excludeIds.has(row.chunk_id)) continue;
    points.push(makePoint(row, "map", null));
  }

  const centerPoint = points.find((p) => p.type === "result") || points[0];
  const center = centerPoint ? { x: centerPoint.x, y: centerPoint.y } : { x: 0, y: 0 };

  return { points, center };
}

// ---------------------------------------------------------------------------
// Neighbor visualization
// ---------------------------------------------------------------------------

export function buildNeighborVisualization(
  db: Database,
  chunkId: string,
  limit = MAP_NEIGHBOR_LIMIT,
): VisualizationPayload | null {
  const rawEmb = getEmbeddingByChunkId(db, chunkId);
  const emb = normalizeEmbedding(rawEmb);
  if (!emb) return null;

  const neighborRows = getKnnNeighbors(db, emb, limit + 1);
  const neighborIds: string[] = [];
  const neighborScores = new Map<string, number>();
  for (const n of neighborRows) {
    if (n.chunk_id === chunkId) continue;
    neighborIds.push(n.chunk_id);
    neighborScores.set(n.chunk_id, 1 / (1 + (n.distance ?? 0)));
  }

  const allIds = [chunkId, ...neighborIds];
  const rowMap = new Map<string, MapChunkRow>();
  getMapChunksByIds(db, allIds).forEach((r) => rowMap.set(r.chunk_id, r));

  const baseRow = rowMap.get(chunkId);
  if (!baseRow) return null;

  const points: VisualizationPoint[] = [makePoint(baseRow, "focus", 1)];
  for (const id of neighborIds) {
    const row = rowMap.get(id);
    if (row) points.push(makePoint(row, "neighbor", neighborScores.get(id) ?? null));
  }

  const center = { x: points[0].x, y: points[0].y };
  return { points, center, focusId: chunkId };
}
