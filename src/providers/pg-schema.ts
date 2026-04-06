/**
 * PostgreSQL schema DDL for code-session-memory.
 * Uses pgvector for embedding storage and PostgreSQL built-in tsvector for FTS.
 */

const DEFAULT_DIM = 3072;

export function getSchemaSQL(embeddingDimension = DEFAULT_DIM): string {
  return `
-- Enable pgvector extension (pre-installed on Supabase)
CREATE EXTENSION IF NOT EXISTS vector;

-- Main chunks table (replaces SQLite vec_items + chunks_fts)
CREATE TABLE IF NOT EXISTS chunks (
  id                BIGSERIAL PRIMARY KEY,
  embedding         vector(${embeddingDimension}),
  chunk_id          TEXT UNIQUE NOT NULL,
  content           TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  session_title     TEXT,
  project           TEXT,
  heading_hierarchy TEXT,
  section           TEXT,
  url               TEXT,
  hash              TEXT,
  chunk_index       INTEGER,
  total_chunks      INTEGER,
  message_order     INTEGER DEFAULT 0,
  created_at        BIGINT
);

-- tsvector column for full-text search (replaces FTS5)
-- We use 'simple' config to avoid stemming code identifiers
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'chunks' AND column_name = 'content_tsv'
  ) THEN
    ALTER TABLE chunks ADD COLUMN content_tsv tsvector
      GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED;
  END IF;
END $$;

-- Indexes on chunks
CREATE INDEX IF NOT EXISTS idx_chunks_session     ON chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_chunks_url         ON chunks(url);
CREATE INDEX IF NOT EXISTS idx_chunks_project     ON chunks(project);
CREATE INDEX IF NOT EXISTS idx_chunks_created     ON chunks(created_at);
CREATE INDEX IF NOT EXISTS idx_chunks_chunk_id    ON chunks(chunk_id);

-- HNSW vector index using halfvec (half-precision) cast.
-- Both HNSW and IVFFlat are limited to 2000 dimensions for full-precision vector,
-- but halfvec supports up to 4000 dimensions — enough for 3072-dim embeddings.
-- Data stays as vector(3072) at full precision; only the index uses half precision.
CREATE INDEX IF NOT EXISTS idx_chunks_embedding
  ON chunks USING hnsw ((embedding::halfvec(${embeddingDimension})) halfvec_cosine_ops);

-- GIN index for full-text search
CREATE INDEX IF NOT EXISTS idx_chunks_fts         ON chunks USING gin(content_tsv);

-- Session metadata
CREATE TABLE IF NOT EXISTS sessions_meta (
  session_id              TEXT PRIMARY KEY,
  session_title           TEXT NOT NULL DEFAULT '',
  project                 TEXT NOT NULL DEFAULT '',
  source                  TEXT NOT NULL DEFAULT 'opencode',
  last_indexed_message_id TEXT,
  updated_at              BIGINT NOT NULL DEFAULT 0,
  transcript_path         TEXT,
  origin_host             TEXT
);

-- Messages table (analytics)
CREATE TABLE IF NOT EXISTS messages (
  id              TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  role            TEXT NOT NULL,
  created_at      BIGINT,
  text_length     INTEGER NOT NULL DEFAULT 0,
  part_count      INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  message_order   INTEGER NOT NULL DEFAULT 0,
  indexed_at      BIGINT NOT NULL,
  PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
CREATE INDEX IF NOT EXISTS idx_messages_role    ON messages(role);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

-- Tool calls table (analytics)
CREATE TABLE IF NOT EXISTS tool_calls (
  id              BIGSERIAL PRIMARY KEY,
  message_id      TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  tool_call_id    TEXT,
  status          TEXT,
  has_error       INTEGER NOT NULL DEFAULT 0,
  args_length     INTEGER NOT NULL DEFAULT 0,
  result_length   INTEGER NOT NULL DEFAULT 0,
  created_at      BIGINT,
  indexed_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_name    ON tool_calls(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_calls_message ON tool_calls(session_id, message_id);
`;
}

/** Migrations to run on an existing schema. */
export function getMigrationsSQL(): string {
  return `
-- Add origin_host column if missing (for multi-desktop merge tracking)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions_meta' AND column_name = 'origin_host'
  ) THEN
    ALTER TABLE sessions_meta ADD COLUMN origin_host TEXT;
  END IF;
END $$;

-- Add transcript_path column if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions_meta' AND column_name = 'transcript_path'
  ) THEN
    ALTER TABLE sessions_meta ADD COLUMN transcript_path TEXT;
  END IF;
END $$;

-- Add source column if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sessions_meta' AND column_name = 'source'
  ) THEN
    ALTER TABLE sessions_meta ADD COLUMN source TEXT NOT NULL DEFAULT 'opencode';
  END IF;
END $$;
`;
}
