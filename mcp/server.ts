/**
 * MCP query handlers for opencode-memory.
 *
 * Adapted from doc2vec/mcp/src/server.ts — simplified to:
 *   - SQLite-vec only (no Qdrant)
 *   - Fixed single DB path (no multi-DB resolution)
 *   - Two tools: query_sessions + get_session_chunks
 */

import type { QueryResult } from "../src/types";

// ---------------------------------------------------------------------------
// Re-export QueryResult for consumers
// ---------------------------------------------------------------------------
export type { QueryResult };

// ---------------------------------------------------------------------------
// Dependency injection types (keeps the module testable without native deps)
// ---------------------------------------------------------------------------

type SqliteVecModule = { load: (db: SqliteDatabase) => void };
type SqliteDatabase = {
  prepare: (sql: string) => SqliteStatement;
  close: () => void;
};
type SqliteStatement = {
  all: (...params: unknown[]) => unknown[];
};
type FsModule = { existsSync: (p: string) => boolean };

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export function createSqliteProvider(deps: {
  dbPath: string;
  sqliteVec: SqliteVecModule;
  Database: new (path: string) => SqliteDatabase;
  fs: FsModule;
}) {
  const { dbPath, sqliteVec, Database, fs } = deps;

  /**
   * Opens a short-lived connection, runs the callback, closes the connection.
   */
  function withDb<T>(fn: (db: SqliteDatabase) => T): T {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`Database not found at ${dbPath}. Run "opencode-memory install" first.`);
    }
    const db = new Database(dbPath);
    sqliteVec.load(db);
    try {
      return fn(db);
    } finally {
      db.close();
    }
  }

  // ---- query_sessions -------------------------------------------------------

  async function querySessions(
    queryEmbedding: number[],
    topK = 10,
    projectFilter?: string,
  ): Promise<QueryResult[]> {
    return withDb((db) => {
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
      rows.forEach((r) => {
        delete (r as unknown as Record<string, unknown>)["embedding"];
      });
      return rows;
    });
  }

  // ---- get_session_chunks ---------------------------------------------------

  async function getSessionChunks(
    url: string,
    startIndex?: number,
    endIndex?: number,
  ): Promise<QueryResult[]> {
    return withDb((db) => {
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
    });
  }

  return { querySessions, getSessionChunks };
}

// ---------------------------------------------------------------------------
// MCP tool handlers
// ---------------------------------------------------------------------------

export function createToolHandlers(deps: {
  createEmbedding: (text: string) => Promise<number[]>;
  querySessions: (
    embedding: number[],
    topK: number,
    project?: string,
  ) => Promise<QueryResult[]>;
  getSessionChunks: (
    url: string,
    startIndex?: number,
    endIndex?: number,
  ) => Promise<QueryResult[]>;
}) {
  const { createEmbedding, querySessions, getSessionChunks } = deps;

  // ---- query_sessions handler -----------------------------------------------

  const querySessionsHandler = async (args: {
    queryText: string;
    project?: string;
    limit?: number;
  }) => {
    const limit = args.limit ?? 5;
    console.error(
      `[query_sessions] text="${args.queryText}" project="${args.project ?? "any"}" limit=${limit}`,
    );

    try {
      const embedding = await createEmbedding(args.queryText);
      const results = await querySessions(embedding, limit, args.project);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No sessions found matching "${args.queryText}"${args.project ? ` in project "${args.project}"` : ""}.`,
            },
          ],
        };
      }

      const formatted = results
        .map((r, i) => {
          const lines = [
            `Result ${i + 1}:`,
            `  Content: ${r.content}`,
            typeof r.distance === "number" ? `  Distance: ${r.distance.toFixed(4)}` : null,
            r.url ? `  URL: ${r.url}` : null,
            r.section ? `  Section: ${r.section}` : null,
            typeof r.chunk_index === "number" && typeof r.total_chunks === "number"
              ? `  Chunk: ${r.chunk_index + 1} of ${r.total_chunks}`
              : null,
            "---",
          ].filter(Boolean);
          return lines.join("\n");
        })
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${results.length} result(s) for "${args.queryText}":\n\n${formatted}`,
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[query_sessions] error:", err);
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
    }
  };

  // ---- get_session_chunks handler -------------------------------------------

  const getSessionChunksHandler = async (args: {
    sessionUrl: string;
    startIndex?: number;
    endIndex?: number;
  }) => {
    console.error(
      `[get_session_chunks] url="${args.sessionUrl}" start=${args.startIndex} end=${args.endIndex}`,
    );

    try {
      const results = await getSessionChunks(
        args.sessionUrl,
        args.startIndex,
        args.endIndex,
      );

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No chunks found for "${args.sessionUrl}".`,
            },
          ],
        };
      }

      const formatted = results
        .map((r) => {
          const chunkLabel =
            typeof r.chunk_index === "number" && typeof r.total_chunks === "number"
              ? `Chunk ${r.chunk_index + 1} of ${r.total_chunks}`
              : "Chunk";
          return [
            chunkLabel,
            `  Content: ${r.content}`,
            r.section ? `  Section: ${r.section}` : null,
            "---",
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Retrieved ${results.length} chunk(s) for "${args.sessionUrl}":\n\n${formatted}`,
          },
        ],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[get_session_chunks] error:", err);
      return { content: [{ type: "text" as const, text: `Error: ${msg}` }] };
    }
  };

  return { querySessionsHandler, getSessionChunksHandler };
}
