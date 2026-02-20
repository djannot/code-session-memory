import path from "path";
import os from "os";
import fs from "fs";
import type { DocumentChunk, SessionMeta, DatabaseConfig, QueryResult } from "./types";

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
  return path.join(os.homedir(), ".local", "share", "opencode-memory", "sessions.db");
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    _Database = require("better-sqlite3");
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
      total_chunks      INTEGER
    );
  `);

  // Metadata table for tracking incremental indexing progress
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions_meta (
      session_id              TEXT PRIMARY KEY,
      session_title           TEXT NOT NULL DEFAULT '',
      project                 TEXT NOT NULL DEFAULT '',
      last_indexed_message_id TEXT,
      updated_at              INTEGER NOT NULL DEFAULT 0
    );
  `);
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
    INSERT INTO sessions_meta (session_id, session_title, project, last_indexed_message_id, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      session_title           = excluded.session_title,
      project                 = excluded.project,
      last_indexed_message_id = excluded.last_indexed_message_id,
      updated_at              = excluded.updated_at
  `).run(
    meta.session_id,
    meta.session_title,
    meta.project,
    meta.last_indexed_message_id,
    meta.updated_at,
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
      chunk_index, total_chunks
    ) VALUES (
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?
    )
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
      );
    }
  });

  insertMany(chunks.map((chunk, i) => ({ chunk, embedding: embeddings[i] })));
}

// ---------------------------------------------------------------------------
// Query helpers (used by MCP server)
// ---------------------------------------------------------------------------

export function queryByEmbedding(
  db: Database,
  queryEmbedding: number[],
  topK = 10,
  projectFilter?: string,
): QueryResult[] {
  let sql = `
    SELECT
      chunk_id, content, url, section, heading_hierarchy,
      chunk_index, total_chunks, session_id, session_title, project,
      distance
    FROM vec_items
    WHERE embedding MATCH ?
  `;
  const params: unknown[] = [new Float32Array(queryEmbedding)];

  if (projectFilter) {
    sql += " AND project = ?";
    params.push(projectFilter);
  }

  sql += " ORDER BY distance LIMIT ?";
  params.push(topK);

  const rows = db.prepare(sql).all(...params) as QueryResult[];
  // Strip raw embedding bytes from results
  rows.forEach((r: unknown) => {
    if (r && typeof r === "object") delete (r as Record<string, unknown>)["embedding"];
  });
  return rows;
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
 * Lists all session URLs stored in the DB (for "get_session_chunks" calls that
 * pass a session_id instead of a full URL).
 */
export function listSessionUrls(db: Database, sessionId: string): string[] {
  const rows = db
    .prepare("SELECT DISTINCT url FROM vec_items WHERE session_id = ? ORDER BY url")
    .all(sessionId) as Array<{ url: string }>;
  return rows.map((r) => r.url);
}
