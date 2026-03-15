import path from "path";
import os from "os";
import fs from "fs";
import { execSync, spawnSync } from "child_process";
import type {
  DocumentChunk, SessionMeta, SessionSource, DatabaseConfig, QueryResult,
  MessageRow, ToolCallRow, AnalyticsFilter, ToolUsageStat, MessageStat,
  OverviewStats, SessionAnalytics,
} from "./types";

const DEFAULT_EMBEDDING_DIMENSION = 3072;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the default DB path cross-platform:
 * - Respects OPENCODE_MEMORY_DB_PATH env var
 * - Falls back to ~/.local/share/opencode-memory/sessions.db (works on both
 *   macOS and Linux)
 */
export function resolveDbPath(overridePath?: string): string {
  if (overridePath) {
    return overridePath.replace(/^~/, os.homedir());
  }
  const envPath = process.env.OPENCODE_MEMORY_DB_PATH;
  if (envPath) {
    return envPath.replace(/^~/, os.homedir());
  }
  return path.join(os.homedir(), ".local", "share", "code-session-memory", "sessions.db");
}

// ---------------------------------------------------------------------------
// Database initialisation
// ---------------------------------------------------------------------------

export interface Database {
  prepare: (sql: string) => Statement;
  exec: (sql: string) => void;
  pragma: (sql: string, opts?: { simple?: boolean }) => unknown;
  close: () => void;
  transaction: <T>(fn: (...args: unknown[]) => T) => (...args: unknown[]) => T;
}

export interface Statement {
  run: (...args: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
  get: (...args: unknown[]) => unknown;
  all: (...args: unknown[]) => unknown[];
}

// Lazy-loaded to avoid requiring the native module at import time (useful in tests).
let _Database: (new (path: string) => Database) | null = null;
let _sqliteVec: { load: (db: Database) => void } | null = null;

function loadDeps() {
  if (!_Database) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      _Database = require("better-sqlite3");
      // Eagerly open an in-memory DB to force the native .node file to load now,
      // so any ABI mismatch is caught here inside our try-catch rather than
      // later in openDatabase() where we have no error handling.
      new (_Database as NonNullable<typeof _Database>)(":memory:").close();
    } catch (err: unknown) {
      _Database = null; // reset so a restarted process starts fresh
      const msg = err instanceof Error ? err.message : String(err);
      const isAbiBroken = msg.includes("NODE_MODULE_VERSION") || msg.includes("Module did not self-register");
      if (isAbiBroken) {
        // Auto-rebuild for the current Node version.
        //
        // Two subtleties:
        // 1. Derive the rebuild root from require.resolve so we always target
        //    the directory that actually contains node_modules/better-sqlite3,
        //    regardless of installation depth.
        // 2. Prepend process.execPath's bin dir to PATH so that prebuild-install
        //    (which shells out to `node` to detect ABI) picks the right version
        //    instead of whatever `node` happens to be first on the shell PATH.
        const betterSqlitePkg = require.resolve("better-sqlite3/package.json");
        const rebuildRoot = path.resolve(betterSqlitePkg, "../../..");
        const nodeDir = path.dirname(process.execPath);
        const npmPath = path.join(nodeDir, "npm");
        const npm = fs.existsSync(npmPath) ? npmPath : "npm";
        const pathSep = process.platform === "win32" ? ";" : ":";
        const env = { ...process.env, PATH: `${nodeDir}${pathSep}${process.env.PATH ?? ""}` };
        try {
          process.stderr.write("[code-session-memory] Rebuilding better-sqlite3 for current Node version...\n");
          execSync(`"${npm}" rebuild better-sqlite3`, { cwd: rebuildRoot, stdio: "pipe", env });
        } catch (rebuildErr: unknown) {
          const rebuildMsg = rebuildErr instanceof Error ? rebuildErr.message : String(rebuildErr);
          throw new Error(
            `better-sqlite3 auto-rebuild failed: ${rebuildMsg}\n` +
            `Try manually: cd ${rebuildRoot} && "${npm}" rebuild better-sqlite3`,
          );
        }
        // In test environments (vitest/jest), calling process.exit() kills the
        // worker process. The rebuild above fixed the binary on disk — just ask
        // the user to re-run the tests.
        if (process.env.VITEST || process.env.JEST_WORKER_ID) {
          throw new Error(
            `better-sqlite3 was rebuilt for Node ${process.version}. Please re-run the tests.`,
          );
        }
        // In CLI processes: native modules can't be reloaded after a failed dlopen,
        // so re-execute the process fresh with a clean module cache.
        process.stderr.write("[code-session-memory] Restarting to apply rebuild...\n");
        const result = spawnSync(process.execPath, process.argv.slice(1), { stdio: "inherit" });
        process.exit(result.status ?? 0);
      } else {
        throw err;
      }
    }
  }
  if (!_sqliteVec) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _sqliteVec = require("sqlite-vec");
  }
  return { Database: _Database!, sqliteVec: _sqliteVec! };
}

/**
 * Opens (or creates) a better-sqlite3 database with the sqlite-vec extension
 * loaded. Initialises the schema if needed.
 */
export function openDatabase(config: DatabaseConfig): Database {
  const { Database, sqliteVec } = loadDeps();
  const { dbPath, embeddingDimension = DEFAULT_EMBEDDING_DIMENSION } = config;

  // Ensure the directory exists
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  sqliteVec.load(db);

  // Performance tuning
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  initSchema(db, embeddingDimension);
  return db;
}

/**
 * Creates the schema tables if they don't already exist.
 * Exported so tests can call it with an in-memory DB.
 */
export function initSchema(db: Database, embeddingDimension = DEFAULT_EMBEDDING_DIMENSION): void {
  // Virtual table for vector search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_items USING vec0(
      embedding         FLOAT[${embeddingDimension}],
      session_id        TEXT,
      session_title     TEXT,
      project           TEXT,
      heading_hierarchy TEXT,
      section           TEXT,
      chunk_id          TEXT UNIQUE,
      content           TEXT,
      url               TEXT,
      hash              TEXT,
      chunk_index       INTEGER,
      total_chunks      INTEGER,
      message_order     INTEGER,
      created_at        INTEGER
    );
  `);

  // Metadata table for tracking incremental indexing progress
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions_meta (
      session_id              TEXT PRIMARY KEY,
      session_title           TEXT NOT NULL DEFAULT '',
      project                 TEXT NOT NULL DEFAULT '',
      source                  TEXT NOT NULL DEFAULT 'opencode',
      last_indexed_message_id TEXT,
      updated_at              INTEGER NOT NULL DEFAULT 0
    );
  `);

  // FTS5 table for keyword search (hybrid search)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      chunk_id UNINDEXED,
      content,
      section UNINDEXED
    );
  `);

  // Backfill FTS from vec_items if needed (one-time migration)
  const ftsCount = db.prepare("SELECT COUNT(*) AS cnt FROM chunks_fts").get() as { cnt: number };
  const vecCount = db.prepare("SELECT COUNT(*) AS cnt FROM vec_items").get() as { cnt: number };
  if (ftsCount.cnt === 0 && vecCount.cnt > 0) {
    db.exec(`INSERT INTO chunks_fts(chunk_id, content, section) SELECT chunk_id, content, section FROM vec_items`);
  }

  // Migrate existing DBs: add source column if missing
  try {
    db.exec(`ALTER TABLE sessions_meta ADD COLUMN source TEXT NOT NULL DEFAULT 'opencode'`);
  } catch {
    // Column already exists — ignore
  }

  // Migrate existing DBs: add transcript_path column if missing
  try {
    db.exec(`ALTER TABLE sessions_meta ADD COLUMN transcript_path TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // Structured analytics tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      role            TEXT NOT NULL,
      created_at      INTEGER,
      text_length     INTEGER NOT NULL DEFAULT 0,
      part_count      INTEGER NOT NULL DEFAULT 0,
      tool_call_count INTEGER NOT NULL DEFAULT 0,
      message_order   INTEGER NOT NULL DEFAULT 0,
      indexed_at      INTEGER NOT NULL,
      PRIMARY KEY (session_id, id)
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_calls (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id      TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      tool_name       TEXT NOT NULL,
      tool_call_id    TEXT,
      status          TEXT,
      has_error       INTEGER NOT NULL DEFAULT 0,
      args_length     INTEGER NOT NULL DEFAULT 0,
      result_length   INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER,
      indexed_at      INTEGER NOT NULL
    );
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls(session_id, message_id)`);
}

// ---------------------------------------------------------------------------
// Session meta CRUD
// ---------------------------------------------------------------------------

export function getSessionMeta(db: Database, sessionId: string): SessionMeta | null {
  const row = db
    .prepare("SELECT * FROM sessions_meta WHERE session_id = ?")
    .get(sessionId) as SessionMeta | undefined;
  return row ?? null;
}

export function upsertSessionMeta(db: Database, meta: SessionMeta): void {
  db.prepare(`
    INSERT INTO sessions_meta (session_id, session_title, project, source, last_indexed_message_id, updated_at, transcript_path)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      session_title           = excluded.session_title,
      project                 = excluded.project,
      source                  = excluded.source,
      last_indexed_message_id = excluded.last_indexed_message_id,
      updated_at              = excluded.updated_at,
      transcript_path         = COALESCE(excluded.transcript_path, sessions_meta.transcript_path)
  `).run(
    meta.session_id,
    meta.session_title,
    meta.project,
    meta.source,
    meta.last_indexed_message_id,
    meta.updated_at,
    meta.transcript_path ?? null,
  );
}

// ---------------------------------------------------------------------------
// Vector insertion
// ---------------------------------------------------------------------------

/**
 * Inserts a batch of chunks + their embeddings inside a single transaction.
 * Chunks with duplicate chunk_ids are silently skipped (IGNORE conflict).
 */
export function insertChunks(
  db: Database,
  chunks: DocumentChunk[],
  embeddings: number[][],
): void {
  if (chunks.length !== embeddings.length) {
    throw new Error(
      `Mismatch: ${chunks.length} chunks but ${embeddings.length} embeddings`,
    );
  }
  if (chunks.length === 0) return;

  const insert = db.prepare(`
    INSERT INTO vec_items (
      embedding, session_id, session_title, project,
      heading_hierarchy, section, chunk_id, content, url, hash,
      chunk_index, total_chunks, message_order, created_at
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )
  `);

  const insertFts = db.prepare(`
    INSERT INTO chunks_fts(chunk_id, content, section) VALUES (?, ?, ?)
  `);

  // sqlite-vec does not enforce UNIQUE constraints via INSERT OR IGNORE on
  // virtual tables, so we check for existence first.
  const exists = db.prepare(
    "SELECT 1 FROM vec_items WHERE chunk_id = ? LIMIT 1",
  );

  const insertMany = db.transaction((...args: unknown[]) => {
    const rows = args[0] as Array<{ chunk: DocumentChunk; embedding: number[] }>;
    for (const { chunk, embedding } of rows) {
      const { metadata: m } = chunk;
      // Skip if chunk already exists (idempotent indexing)
      if (exists.get(m.chunk_id)) continue;
      insert.run(
        new Float32Array(embedding),
        m.session_id,
        m.session_title,
        m.project,
        JSON.stringify(m.heading_hierarchy),
        m.section,
        m.chunk_id,
        chunk.content,
        m.url,
        m.hash,
        BigInt(m.chunk_index),
        BigInt(m.total_chunks),
        BigInt(m.message_order ?? 0),
        BigInt(m.created_at ?? Date.now()),
      );
      insertFts.run(m.chunk_id, chunk.content, m.section);
    }
  });

  insertMany(chunks.map((chunk, i) => ({ chunk, embedding: embeddings[i] })));
}

// ---------------------------------------------------------------------------
// Structured analytics insertion
// ---------------------------------------------------------------------------

/**
 * Batch-inserts message rows. Duplicate (session_id, id) pairs are silently
 * skipped via INSERT OR IGNORE (idempotent for incremental indexing).
 */
export function insertMessages(db: Database, rows: MessageRow[]): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO messages
      (id, session_id, role, created_at, text_length, part_count,
       tool_call_count, message_order, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((...args: unknown[]) => {
    const items = args[0] as MessageRow[];
    for (const r of items) {
      stmt.run(
        r.id, r.session_id, r.role, r.created_at,
        r.text_length, r.part_count, r.tool_call_count,
        r.message_order, r.indexed_at,
      );
    }
  });
  insertMany(rows);
}

/**
 * Batch-inserts tool call rows.
 */
export function insertToolCalls(db: Database, rows: ToolCallRow[]): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO tool_calls
      (message_id, session_id, tool_name, tool_call_id, status, has_error,
       args_length, result_length, created_at, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMany = db.transaction((...args: unknown[]) => {
    const items = args[0] as ToolCallRow[];
    for (const r of items) {
      stmt.run(
        r.message_id, r.session_id, r.tool_name, r.tool_call_id,
        r.status, r.has_error, r.args_length, r.result_length,
        r.created_at, r.indexed_at,
      );
    }
  });
  insertMany(rows);
}

// ---------------------------------------------------------------------------
// Query helpers (used by MCP server)
// ---------------------------------------------------------------------------

export interface SectionFilterOptions {
  /** Single prefix (backward compat). Matches LOWER(section) LIKE prefix%. */
  sectionFilter?: string;
  /** Include only chunks whose section matches one of these prefixes. */
  includeSections?: string[];
  /** Exclude chunks whose section matches any of these prefixes. */
  excludeSections?: string[];
}

function appendSectionFilters(
  sql: string,
  params: unknown[],
  col: string,
  opts: SectionFilterOptions,
): string {
  if (opts.sectionFilter) {
    sql += ` AND LOWER(${col}) LIKE ?`;
    params.push(opts.sectionFilter.toLowerCase() + "%");
  }
  if (opts.includeSections && opts.includeSections.length > 0) {
    const clauses = opts.includeSections.map(() => `LOWER(${col}) LIKE ?`);
    sql += ` AND (${clauses.join(" OR ")})`;
    for (const prefix of opts.includeSections) {
      params.push(prefix.toLowerCase() + "%");
    }
  }
  if (opts.excludeSections && opts.excludeSections.length > 0) {
    for (const prefix of opts.excludeSections) {
      sql += ` AND LOWER(${col}) NOT LIKE ?`;
      params.push(prefix.toLowerCase() + "%");
    }
  }
  return sql;
}

export function queryByEmbedding(
  db: Database,
  queryEmbedding: number[],
  topK = 10,
  projectFilter?: string,
  sourceFilter?: SessionSource,
  fromMs?: number,
  toMs?: number,
  sectionFilter?: string,
  sectionOpts?: SectionFilterOptions,
): QueryResult[] {
  // sqlite-vec requires the LIMIT (k) constraint to be part of the KNN WHERE
  // clause. We use a CTE to perform the KNN first, then join sessions_meta for
  // the source column and apply optional post-filters.
  // When section filters are active, over-fetch from KNN so that after post-
  // filtering we still have enough results to fill the requested topK.
  const hasSectionFilter = !!(sectionFilter || sectionOpts?.includeSections?.length || sectionOpts?.excludeSections?.length);
  const knnK = hasSectionFilter ? topK * 5 : topK;

  let sql = `
    WITH knn AS (
      SELECT
        chunk_id, content, url, section, heading_hierarchy,
        chunk_index, total_chunks, session_id, session_title, project,
        distance, created_at
      FROM vec_items
      WHERE embedding MATCH ?
        AND k = ?
    )
    SELECT knn.*, m.source
    FROM knn
    LEFT JOIN sessions_meta m ON knn.session_id = m.session_id
    WHERE 1=1
  `;
  const params: unknown[] = [new Float32Array(queryEmbedding), knnK];

  if (projectFilter) {
    sql += " AND knn.project = ?";
    params.push(projectFilter);
  }

  if (sourceFilter) {
    sql += " AND m.source = ?";
    params.push(sourceFilter);
  }

  if (typeof fromMs === "number") {
    sql += " AND knn.created_at >= ?";
    params.push(BigInt(fromMs));
  }

  if (typeof toMs === "number") {
    sql += " AND knn.created_at <= ?";
    params.push(BigInt(toMs));
  }

  // Section filtering (backward compat single prefix + new multi-prefix options)
  sql = appendSectionFilters(sql, params, "knn.section", { sectionFilter, ...sectionOpts });

  sql += " ORDER BY distance";

  let rows = db.prepare(sql).all(...params) as QueryResult[];
  // Strip raw embedding bytes from results
  rows.forEach((r: unknown) => {
    if (r && typeof r === "object") delete (r as Record<string, unknown>)["embedding"];
  });
  // Truncate to requested topK after post-filtering
  if (rows.length > topK) rows = rows.slice(0, topK);
  return rows;
}

/**
 * Full-text keyword search using FTS5 with BM25 ranking.
 * Falls back to empty results if the FTS table is empty.
 */
export function queryByKeyword(
  db: Database,
  queryText: string,
  topK = 10,
  projectFilter?: string,
  sourceFilter?: SessionSource,
  fromMs?: number,
  toMs?: number,
  sectionFilter?: string,
  sectionOpts?: SectionFilterOptions,
): QueryResult[] {
  // Escape FTS5 special characters and wrap terms for prefix matching
  const sanitized = queryText.replace(/['"*(){}[\]:^~!\\]/g, " ").trim();
  if (!sanitized) return [];

  let sql = `
    SELECT
      v.chunk_id, v.content, v.url, v.section, v.heading_hierarchy,
      v.chunk_index, v.total_chunks, v.session_id, v.session_title, v.project,
      v.created_at, m.source,
      bm25(chunks_fts) AS rank
    FROM chunks_fts f
    JOIN vec_items v ON f.chunk_id = v.chunk_id
    LEFT JOIN sessions_meta m ON v.session_id = m.session_id
    WHERE chunks_fts MATCH ?
  `;
  const params: unknown[] = [sanitized];

  if (projectFilter) {
    sql += " AND v.project = ?";
    params.push(projectFilter);
  }
  if (sourceFilter) {
    sql += " AND m.source = ?";
    params.push(sourceFilter);
  }
  if (typeof fromMs === "number") {
    sql += " AND v.created_at >= ?";
    params.push(BigInt(fromMs));
  }
  if (typeof toMs === "number") {
    sql += " AND v.created_at <= ?";
    params.push(BigInt(toMs));
  }
  sql = appendSectionFilters(sql, params, "v.section", { sectionFilter, ...sectionOpts });

  sql += ` ORDER BY rank LIMIT ?`;
  params.push(topK);

  try {
    const rows = db.prepare(sql).all(...params) as QueryResult[];
    rows.forEach((r: unknown) => {
      if (r && typeof r === "object") {
        delete (r as Record<string, unknown>)["embedding"];
        delete (r as Record<string, unknown>)["rank"];
      }
    });
    return rows;
  } catch {
    // FTS table might be empty or query might be invalid
    return [];
  }
}

/**
 * Hybrid search: runs both vector and keyword search, merges results
 * using Reciprocal Rank Fusion (RRF).
 */
export function queryHybrid(
  db: Database,
  queryEmbedding: number[],
  queryText: string,
  topK = 10,
  projectFilter?: string,
  sourceFilter?: SessionSource,
  fromMs?: number,
  toMs?: number,
  sectionFilter?: string,
  sectionOpts?: SectionFilterOptions,
): QueryResult[] {
  const overFetch = topK * 3;

  const vectorResults = queryByEmbedding(
    db, queryEmbedding, overFetch, projectFilter, sourceFilter, fromMs, toMs, sectionFilter, sectionOpts,
  );
  const keywordResults = queryByKeyword(
    db, queryText, overFetch, projectFilter, sourceFilter, fromMs, toMs, sectionFilter, sectionOpts,
  );

  // RRF constant (standard value)
  const K = 60;

  // Build score map by chunk_id
  const scores = new Map<string, { score: number; result: QueryResult }>();

  for (let i = 0; i < vectorResults.length; i++) {
    const r = vectorResults[i];
    const rrfScore = 1 / (K + i + 1);
    scores.set(r.chunk_id, { score: rrfScore, result: r });
  }

  for (let i = 0; i < keywordResults.length; i++) {
    const r = keywordResults[i];
    const rrfScore = 1 / (K + i + 1);
    const existing = scores.get(r.chunk_id);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(r.chunk_id, { score: rrfScore, result: r });
    }
  }

  // Sort by combined RRF score descending, take topK
  return Array.from(scores.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((entry) => entry.result);
}

export function getChunksByUrl(
  db: Database,
  url: string,
  startIndex?: number,
  endIndex?: number,
): QueryResult[] {
  let sql = `
    SELECT chunk_id, content, url, section, heading_hierarchy, chunk_index, total_chunks
    FROM vec_items
    WHERE url = ?
  `;
  const params: unknown[] = [url];

  if (typeof startIndex === "number") {
    sql += " AND chunk_index >= ?";
    params.push(startIndex);
  }
  if (typeof endIndex === "number") {
    sql += " AND chunk_index <= ?";
    params.push(endIndex);
  }

  sql += " ORDER BY chunk_index";
  return db.prepare(sql).all(...params) as QueryResult[];
}

/**
 * Fetches a window of chunks around a target chunk within the same session.
 * Orders all session chunks by created_at + chunk_index, finds the target,
 * and returns `window` chunks before and after it.
 */
export function getSessionContext(
  db: Database,
  sessionId: string,
  chunkId: string,
  windowSize = 1,
): QueryResult[] {
  // Get all chunks for the session, ordered chronologically
  const allChunks = db.prepare(`
    SELECT chunk_id, content, url, section, heading_hierarchy,
           chunk_index, total_chunks, created_at
    FROM vec_items
    WHERE session_id = ?
    ORDER BY created_at, chunk_index
  `).all(sessionId) as QueryResult[];

  const targetIdx = allChunks.findIndex((c) => c.chunk_id === chunkId);
  if (targetIdx === -1) return [];

  const start = Math.max(0, targetIdx - windowSize);
  const end = Math.min(allChunks.length - 1, targetIdx + windowSize);
  return allChunks.slice(start, end + 1);
}

/**
 * Lists all session URLs stored in the DB (for "get_session_chunks" calls that
 * pass a session_id instead of a full URL).
 */
export function listSessionUrls(db: Database, sessionId: string): string[] {
  const rows = db
    .prepare("SELECT DISTINCT url FROM vec_items WHERE session_id = ? ORDER BY url")
    .all(sessionId) as Array<{ url: string }>;
  return rows.map((r) => r.url);
}

// ---------------------------------------------------------------------------
// Session browser helpers
// ---------------------------------------------------------------------------

export interface SessionRow extends SessionMeta {
  chunk_count: number;
}

export interface SessionFilter {
  source?: SessionSource;
  fromDate?: number; // unix timestamp (seconds)
  toDate?: number;   // unix timestamp (seconds)
}

/**
 * Returns all sessions from sessions_meta enriched with their chunk count,
 * ordered by updated_at DESC.
 */
export function listSessions(db: Database, filter: SessionFilter = {}): SessionRow[] {
  let sql = `
    SELECT
      m.session_id,
      m.session_title,
      m.project,
      m.source,
      m.last_indexed_message_id,
      m.updated_at,
      COUNT(v.chunk_id) AS chunk_count
    FROM sessions_meta m
    LEFT JOIN vec_items v ON v.session_id = m.session_id
    WHERE 1=1
  `;
  const params: unknown[] = [];

  if (filter.source) {
    sql += " AND m.source = ?";
    params.push(filter.source);
  }
  if (typeof filter.fromDate === "number") {
    sql += " AND m.updated_at >= ?";
    params.push(filter.fromDate);
  }
  if (typeof filter.toDate === "number") {
    sql += " AND m.updated_at <= ?";
    params.push(filter.toDate);
  }

  sql += " GROUP BY m.session_id ORDER BY m.updated_at DESC";

  return db.prepare(sql).all(...params) as SessionRow[];
}

export interface ChunkRow {
  chunk_id: string;
  chunk_index: number;
  total_chunks: number;
  section: string;
  heading_hierarchy: string; // JSON-encoded string[]
  content: string;
  url: string;
}

/**
 * Returns all chunks for a session ordered by message_order ASC, chunk_index ASC.
 * message_order is the 0-based position of the message within the session at
 * index time — stable and source-agnostic (works for OpenCode, Claude Code,
 * and Cursor whose message IDs are not guaranteed to sort chronologically).
 */
export function getSessionChunksOrdered(db: Database, sessionId: string): ChunkRow[] {
  return db.prepare(`
    SELECT chunk_id, chunk_index, total_chunks, section, heading_hierarchy, content, url
    FROM vec_items
    WHERE session_id = ?
    ORDER BY message_order ASC, chunk_index ASC
  `).all(sessionId) as ChunkRow[];
}

/**
 * Deletes a session's chunks and metadata inside a single transaction.
 * Returns the number of chunks deleted.
 */
export function deleteSession(db: Database, sessionId: string): number {
  const selectChunkIds = db.prepare("SELECT chunk_id FROM vec_items WHERE session_id = ?");
  const deleteChunks = db.prepare("DELETE FROM vec_items WHERE session_id = ?");
  const deleteFts    = db.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?");
  const deleteMeta   = db.prepare("DELETE FROM sessions_meta WHERE session_id = ?");
  const deleteMessages  = db.prepare("DELETE FROM messages WHERE session_id = ?");
  const deleteToolCalls = db.prepare("DELETE FROM tool_calls WHERE session_id = ?");

  let chunkCount = 0;
  db.transaction(() => {
    const chunkIds = selectChunkIds.all(sessionId) as Array<{ chunk_id: string }>;
    for (const { chunk_id } of chunkIds) {
      deleteFts.run(chunk_id);
    }
    const result = deleteChunks.run(sessionId);
    chunkCount = result.changes;
    deleteToolCalls.run(sessionId);
    deleteMessages.run(sessionId);
    deleteMeta.run(sessionId);
  })();

  return chunkCount;
}

/**
 * Deletes all sessions last updated before `olderThanMs` (unix milliseconds).
 * Returns the number of sessions and chunks removed.
 */
export function deleteSessionsOlderThan(
  db: Database,
  olderThanMs: number,
): { sessions: number; chunks: number } {
  const candidates = listSessions(db, { toDate: olderThanMs });
  if (candidates.length === 0) return { sessions: 0, chunks: 0 };

  const selectChunkIds = db.prepare("SELECT chunk_id FROM vec_items WHERE session_id = ?");
  const deleteChunks = db.prepare("DELETE FROM vec_items WHERE session_id = ?");
  const deleteFts    = db.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?");
  const deleteMeta   = db.prepare("DELETE FROM sessions_meta WHERE session_id = ?");
  const deleteMessages  = db.prepare("DELETE FROM messages WHERE session_id = ?");
  const deleteToolCalls = db.prepare("DELETE FROM tool_calls WHERE session_id = ?");

  let totalChunks = 0;
  db.transaction(() => {
    for (const s of candidates) {
      const chunkIds = selectChunkIds.all(s.session_id) as Array<{ chunk_id: string }>;
      for (const { chunk_id } of chunkIds) {
        deleteFts.run(chunk_id);
      }
      const result = deleteChunks.run(s.session_id);
      totalChunks += result.changes;
      deleteToolCalls.run(s.session_id);
      deleteMessages.run(s.session_id);
      deleteMeta.run(s.session_id);
    }
  })();

  return { sessions: candidates.length, chunks: totalChunks };
}

// ---------------------------------------------------------------------------
// Analytics queries
// ---------------------------------------------------------------------------

function buildAnalyticsWhere(
  filter: AnalyticsFilter | undefined,
  tableAlias: string,
  metaAlias: string,
): { clauses: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter?.source) {
    clauses.push(`${metaAlias}.source = ?`);
    params.push(filter.source);
  }
  if (filter?.project) {
    clauses.push(`${metaAlias}.project = ?`);
    params.push(filter.project);
  }
  if (typeof filter?.fromMs === "number") {
    clauses.push(`${tableAlias}.created_at >= ?`);
    params.push(filter.fromMs);
  }
  if (typeof filter?.toMs === "number") {
    clauses.push(`${tableAlias}.created_at <= ?`);
    params.push(filter.toMs);
  }
  return {
    clauses: clauses.length > 0 ? " AND " + clauses.join(" AND ") : "",
    params,
  };
}

/**
 * Returns tool usage stats: call count, error count, and distinct session count per tool.
 */
export function getToolUsageStats(
  db: Database,
  filter?: AnalyticsFilter,
): ToolUsageStat[] {
  const { clauses, params } = buildAnalyticsWhere(filter, "t", "m");
  return db.prepare(`
    SELECT
      t.tool_name,
      COUNT(*)                       AS call_count,
      SUM(t.has_error)               AS error_count,
      COUNT(DISTINCT t.session_id)   AS session_count
    FROM tool_calls t
    JOIN sessions_meta m ON t.session_id = m.session_id
    WHERE 1=1${clauses}
    GROUP BY t.tool_name
    ORDER BY call_count DESC
  `).all(...params) as ToolUsageStat[];
}

/**
 * Returns message counts grouped by role.
 */
export function getMessageStats(
  db: Database,
  filter?: AnalyticsFilter,
): MessageStat[] {
  const { clauses, params } = buildAnalyticsWhere(filter, "msg", "m");
  return db.prepare(`
    SELECT
      msg.role,
      COUNT(*) AS count
    FROM messages msg
    JOIN sessions_meta m ON msg.session_id = m.session_id
    WHERE 1=1${clauses}
    GROUP BY msg.role
    ORDER BY count DESC
  `).all(...params) as MessageStat[];
}

/**
 * Returns aggregate overview stats across all indexed structured data.
 */
export function getOverviewStats(
  db: Database,
  filter?: AnalyticsFilter,
): OverviewStats {
  const { clauses: msgClauses, params: msgParams } = buildAnalyticsWhere(filter, "msg", "m");
  const msgStats = db.prepare(`
    SELECT
      COUNT(DISTINCT msg.session_id)  AS total_sessions,
      COUNT(*)                        AS total_messages,
      MIN(msg.created_at)             AS earliest_message_at,
      MAX(msg.created_at)             AS latest_message_at
    FROM messages msg
    JOIN sessions_meta m ON msg.session_id = m.session_id
    WHERE 1=1${msgClauses}
  `).get(...msgParams) as {
    total_sessions: number;
    total_messages: number;
    earliest_message_at: number | null;
    latest_message_at: number | null;
  };

  const { clauses: tcClauses, params: tcParams } = buildAnalyticsWhere(filter, "t", "m");
  const tcStats = db.prepare(`
    SELECT COUNT(*) AS total_tool_calls
    FROM tool_calls t
    JOIN sessions_meta m ON t.session_id = m.session_id
    WHERE 1=1${tcClauses}
  `).get(...tcParams) as { total_tool_calls: number };

  return {
    total_sessions: msgStats.total_sessions,
    total_messages: msgStats.total_messages,
    total_tool_calls: tcStats.total_tool_calls,
    earliest_message_at: msgStats.earliest_message_at,
    latest_message_at: msgStats.latest_message_at,
  };
}

/**
 * Returns detailed analytics for a single session.
 */
export function getSessionAnalytics(
  db: Database,
  sessionId: string,
): SessionAnalytics | null {
  const msgCount = db.prepare(
    "SELECT COUNT(*) AS cnt FROM messages WHERE session_id = ?",
  ).get(sessionId) as { cnt: number };
  if (msgCount.cnt === 0) return null;

  const tcCount = db.prepare(
    "SELECT COUNT(*) AS cnt FROM tool_calls WHERE session_id = ?",
  ).get(sessionId) as { cnt: number };

  // Approximate active session duration: sum of consecutive message gaps,
  // capping each gap at 30 minutes to exclude idle periods (overnight, etc.)
  const duration = db.prepare(`
    WITH ordered AS (
      SELECT created_at,
             LEAD(created_at) OVER (ORDER BY message_order) AS next_at
      FROM messages
      WHERE session_id = ? AND created_at IS NOT NULL
    )
    SELECT COALESCE(SUM(
      CASE WHEN next_at - created_at <= 1800000
           THEN next_at - created_at
           ELSE 0
      END
    ), 0) AS approx_duration_ms
    FROM ordered
    WHERE next_at IS NOT NULL
  `).get(sessionId) as { approx_duration_ms: number | null };

  const messagesByRole = db.prepare(`
    SELECT role, COUNT(*) AS count
    FROM messages WHERE session_id = ?
    GROUP BY role ORDER BY count DESC
  `).all(sessionId) as MessageStat[];

  const toolBreakdown = db.prepare(`
    SELECT
      tool_name,
      COUNT(*)         AS call_count,
      SUM(has_error)   AS error_count,
      1                AS session_count
    FROM tool_calls WHERE session_id = ?
    GROUP BY tool_name ORDER BY call_count DESC
  `).all(sessionId) as ToolUsageStat[];

  return {
    session_id: sessionId,
    message_count: msgCount.cnt,
    tool_call_count: tcCount.cnt,
    approx_duration_ms: duration.approx_duration_ms,
    messages_by_role: messagesByRole,
    tool_breakdown: toolBreakdown,
  };
}
