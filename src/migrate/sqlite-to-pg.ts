/**
 * Migration tool: reads all data from one or more SQLite databases and writes
 * to PostgreSQL, including raw embedding vectors (no re-embedding required).
 *
 * Supports merging multiple SQLite DBs into a single Postgres instance
 * for multi-desktop consolidation.
 */

import os from "os";
import fs from "fs";
import path from "path";
import type { PostgresBackendConfig } from "../config";
import { resolveBackendConfig, loadConfigFile } from "../config";
import type { SessionMeta, MessageRow, ToolCallRow } from "../types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MigrationOptions {
  /** One or more SQLite DB paths to migrate from. */
  sqlitePaths: string[];
  /** Postgres config (reads from code-session-memory config if not provided). */
  pgConfig?: PostgresBackendConfig;
  /** Label for this source machine (default: os.hostname()). */
  originHost?: string;
  /** Preview without writing. */
  dryRun?: boolean;
  /** Rows per INSERT batch (default 100). */
  batchSize?: number;
  /** Progress callback. */
  onProgress?: (event: MigrationProgress) => void;
}

export interface MigrationProgress {
  phase: "sessions" | "chunks" | "messages" | "tool_calls";
  sqlitePath: string;
  processed: number;
  total: number;
}

export interface MigrationReport {
  sqlitePaths: string[];
  sessions: number;
  chunks: number;
  messages: number;
  toolCalls: number;
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Auto-discover SQLite DB
// ---------------------------------------------------------------------------

export function discoverSqliteDbPaths(): string[] {
  const defaultPath = path.join(os.homedir(), ".local", "share", "code-session-memory", "sessions.db");
  const envPath = process.env.OPENCODE_MEMORY_DB_PATH?.replace(/^~/, os.homedir());

  const paths: string[] = [];
  if (envPath && fs.existsSync(envPath)) paths.push(envPath);
  if (fs.existsSync(defaultPath) && !paths.includes(defaultPath)) paths.push(defaultPath);
  return paths;
}

// ---------------------------------------------------------------------------
// Resolve Postgres config
// ---------------------------------------------------------------------------

function resolvePgConfig(override?: PostgresBackendConfig): PostgresBackendConfig {
  if (override) return override;

  const config = resolveBackendConfig();
  if (config.backend !== "postgres") {
    throw new Error(
      "No Postgres backend configured. Run 'code-session-memory config set-backend postgres --url <url>' first, " +
      "or pass --pg-url <url> directly.",
    );
  }
  return config;
}

// ---------------------------------------------------------------------------
// Migration logic
// ---------------------------------------------------------------------------

export async function migrateSqliteToPg(options: MigrationOptions): Promise<MigrationReport> {
  const pgConfig = resolvePgConfig(options.pgConfig);
  const originHost = options.originHost ?? os.hostname();
  const batchSize = options.batchSize ?? 100;
  const dryRun = options.dryRun ?? false;

  const report: MigrationReport = {
    sqlitePaths: options.sqlitePaths,
    sessions: 0,
    chunks: 0,
    messages: 0,
    toolCalls: 0,
    dryRun,
  };

  // Lazy-load native modules
  const BetterSqlite3 = require("better-sqlite3");
  const sqliteVec = require("sqlite-vec");
  const pg = await import("pg");

  const pool = new pg.Pool({
    connectionString: pgConfig.connectionString,
    ssl: pgConfig.ssl ? { rejectUnauthorized: false } : undefined,
    max: 2,
  });

  // Ensure PG schema exists
  const { getSchemaSQL, getMigrationsSQL } = await import("../providers/pg-schema");
  const initClient = await pool.connect();
  try {
    await initClient.query(getSchemaSQL(pgConfig.embeddingDimension));
    await initClient.query(getMigrationsSQL());
  } finally {
    initClient.release();
  }

  for (const sqlitePath of options.sqlitePaths) {
    if (!fs.existsSync(sqlitePath)) {
      process.stderr.write(`[migrate] SQLite DB not found: ${sqlitePath}\n`);
      continue;
    }

    const sqliteDb = new BetterSqlite3(sqlitePath);
    sqliteVec.load(sqliteDb);

    try {
      // --- Phase 1: Migrate sessions_meta ---
      const sessions = sqliteDb.prepare("SELECT * FROM sessions_meta").all() as SessionMeta[];
      options.onProgress?.({ phase: "sessions", sqlitePath, processed: 0, total: sessions.length });

      if (!dryRun) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (const s of sessions) {
            await client.query(`
              INSERT INTO sessions_meta (session_id, session_title, project, source,
                last_indexed_message_id, updated_at, transcript_path, origin_host)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
              ON CONFLICT (session_id) DO UPDATE SET
                session_title           = CASE WHEN EXCLUDED.updated_at > sessions_meta.updated_at THEN EXCLUDED.session_title ELSE sessions_meta.session_title END,
                project                 = CASE WHEN EXCLUDED.updated_at > sessions_meta.updated_at THEN EXCLUDED.project ELSE sessions_meta.project END,
                source                  = CASE WHEN EXCLUDED.updated_at > sessions_meta.updated_at THEN EXCLUDED.source ELSE sessions_meta.source END,
                last_indexed_message_id = CASE WHEN EXCLUDED.updated_at > sessions_meta.updated_at THEN EXCLUDED.last_indexed_message_id ELSE sessions_meta.last_indexed_message_id END,
                updated_at              = GREATEST(sessions_meta.updated_at, EXCLUDED.updated_at),
                transcript_path         = COALESCE(EXCLUDED.transcript_path, sessions_meta.transcript_path),
                origin_host             = COALESCE(EXCLUDED.origin_host, sessions_meta.origin_host)
            `, [
              s.session_id, s.session_title, s.project, s.source,
              s.last_indexed_message_id, s.updated_at,
              s.transcript_path ?? null, originHost,
            ]);
          }
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      }
      report.sessions += sessions.length;
      options.onProgress?.({ phase: "sessions", sqlitePath, processed: sessions.length, total: sessions.length });

      // --- Phase 2: Migrate chunks (including embeddings) ---
      const totalChunks = (sqliteDb.prepare("SELECT COUNT(*) as n FROM vec_items").get() as { n: number }).n;
      options.onProgress?.({ phase: "chunks", sqlitePath, processed: 0, total: totalChunks });

      if (!dryRun && totalChunks > 0) {
        // Read all chunks with raw embedding data
        const allRows = sqliteDb.prepare(`
          SELECT embedding, chunk_id, content, session_id, session_title, project,
                 heading_hierarchy, section, url, hash,
                 chunk_index, total_chunks, message_order, created_at
          FROM vec_items
        `).all() as Array<Record<string, unknown>>;

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (let i = 0; i < allRows.length; i += batchSize) {
            const batch = allRows.slice(i, i + batchSize);
            for (const row of batch) {
              // Convert raw Float32 buffer to pgvector literal
              const buf = row.embedding as Buffer;
              const floats = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
              const vecLiteral = "[" + Array.from(floats).join(",") + "]";

              await client.query(`
                INSERT INTO chunks (embedding, chunk_id, content, session_id, session_title,
                  project, heading_hierarchy, section, url, hash,
                  chunk_index, total_chunks, message_order, created_at)
                VALUES ($1::vector, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                ON CONFLICT (chunk_id) DO NOTHING
              `, [
                vecLiteral,
                row.chunk_id, row.content, row.session_id, row.session_title,
                row.project, row.heading_hierarchy, row.section, row.url, row.hash,
                row.chunk_index, row.total_chunks, row.message_order ?? 0, row.created_at,
              ]);
            }
            options.onProgress?.({ phase: "chunks", sqlitePath, processed: Math.min(i + batchSize, allRows.length), total: totalChunks });
          }
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      }
      report.chunks += totalChunks;

      // --- Phase 3: Migrate messages ---
      let totalMessages = 0;
      try {
        totalMessages = (sqliteDb.prepare("SELECT COUNT(*) as n FROM messages").get() as { n: number }).n;
      } catch { /* table may not exist */ }

      if (!dryRun && totalMessages > 0) {
        const allMsgs = sqliteDb.prepare("SELECT * FROM messages").all() as MessageRow[];
        options.onProgress?.({ phase: "messages", sqlitePath, processed: 0, total: totalMessages });

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (let i = 0; i < allMsgs.length; i += batchSize) {
            const batch = allMsgs.slice(i, i + batchSize);
            for (const r of batch) {
              await client.query(`
                INSERT INTO messages (id, session_id, role, created_at, text_length,
                  part_count, tool_call_count, message_order, indexed_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (session_id, id) DO NOTHING
              `, [
                r.id, r.session_id, r.role, r.created_at,
                r.text_length, r.part_count, r.tool_call_count,
                r.message_order, r.indexed_at,
              ]);
            }
            options.onProgress?.({ phase: "messages", sqlitePath, processed: Math.min(i + batchSize, allMsgs.length), total: totalMessages });
          }
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      }
      report.messages += totalMessages;

      // --- Phase 4: Migrate tool_calls ---
      let totalToolCalls = 0;
      try {
        totalToolCalls = (sqliteDb.prepare("SELECT COUNT(*) as n FROM tool_calls").get() as { n: number }).n;
      } catch { /* table may not exist */ }

      if (!dryRun && totalToolCalls > 0) {
        // Get all session IDs that have tool calls
        const sessionIds = sqliteDb.prepare(
          "SELECT DISTINCT session_id FROM tool_calls"
        ).all() as Array<{ session_id: string }>;

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          // Delete existing tool_calls for these sessions (no unique key, so clear+reinsert)
          for (const { session_id } of sessionIds) {
            await client.query("DELETE FROM tool_calls WHERE session_id = $1", [session_id]);
          }

          const allTc = sqliteDb.prepare(
            "SELECT message_id, session_id, tool_name, tool_call_id, status, has_error, args_length, result_length, created_at, indexed_at FROM tool_calls"
          ).all() as ToolCallRow[];

          options.onProgress?.({ phase: "tool_calls", sqlitePath, processed: 0, total: totalToolCalls });

          for (let i = 0; i < allTc.length; i += batchSize) {
            const batch = allTc.slice(i, i + batchSize);
            for (const r of batch) {
              await client.query(`
                INSERT INTO tool_calls (message_id, session_id, tool_name, tool_call_id,
                  status, has_error, args_length, result_length, created_at, indexed_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
              `, [
                r.message_id, r.session_id, r.tool_name, r.tool_call_id,
                r.status, r.has_error, r.args_length, r.result_length,
                r.created_at, r.indexed_at,
              ]);
            }
            options.onProgress?.({ phase: "tool_calls", sqlitePath, processed: Math.min(i + batchSize, allTc.length), total: totalToolCalls });
          }
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      }
      report.toolCalls += totalToolCalls;
    } finally {
      sqliteDb.close();
    }
  }

  // Build the IVFFlat vector index now that data is present
  if (!dryRun && report.chunks > 0) {
    options.onProgress?.({ phase: "chunks", sqlitePath: "(vector index)", processed: 0, total: 1 });
    const { PgDatabaseProvider } = await import("../providers/pg-provider");
    const pgProvider = new PgDatabaseProvider(pgConfig);
    await pgProvider.initialize();
    await pgProvider.ensureVectorIndex();
    await pgProvider.close();
    options.onProgress?.({ phase: "chunks", sqlitePath: "(vector index)", processed: 1, total: 1 });
  }

  await pool.end();
  return report;
}
