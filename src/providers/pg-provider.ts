import type { Pool, PoolClient } from "pg";
import type { DatabaseProvider, QueryFilters } from "./types";
import type {
  DocumentChunk, SessionMeta, QueryResult,
  MessageRow, ToolCallRow, AnalyticsFilter, ToolUsageStat, MessageStat,
  OverviewStats, SessionAnalytics,
} from "../types";
import type { SessionRow, SessionFilter, ChunkRow } from "../database";
import type { PostgresBackendConfig } from "../config";
import { getSchemaSQL, getMigrationsSQL } from "./pg-schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a number[] as pgvector literal '[0.1,0.2,...]' */
function toVectorLiteral(arr: number[]): string {
  return "[" + arr.join(",") + "]";
}

/** Build WHERE clause fragments + params for section filtering (Postgres $N placeholders) */
function appendSectionFilters(
  sql: string,
  params: unknown[],
  col: string,
  opts: { sectionFilter?: string; sectionOpts?: QueryFilters["sectionOpts"] },
): { sql: string; paramIdx: number } {
  let idx = params.length + 1; // next $N placeholder
  if (opts.sectionFilter) {
    sql += ` AND LOWER(${col}) LIKE $${idx++}`;
    params.push(opts.sectionFilter.toLowerCase() + "%");
  }
  const so = opts.sectionOpts;
  if (so?.includeSections && so.includeSections.length > 0) {
    const clauses = so.includeSections.map(() => `LOWER(${col}) LIKE $${idx++}`);
    sql += ` AND (${clauses.join(" OR ")})`;
    for (const prefix of so.includeSections) params.push(prefix.toLowerCase() + "%");
  }
  if (so?.excludeSections && so.excludeSections.length > 0) {
    for (const prefix of so.excludeSections) {
      sql += ` AND LOWER(${col}) NOT LIKE $${idx++}`;
      params.push(prefix.toLowerCase() + "%");
    }
  }
  return { sql, paramIdx: idx };
}

/** Build WHERE + params for analytics filters */
function buildAnalyticsWhere(
  filter: AnalyticsFilter | undefined,
  tableAlias: string,
  metaAlias: string,
  startIdx = 1,
): { clauses: string; params: unknown[]; nextIdx: number } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let idx = startIdx;
  if (filter?.source) {
    clauses.push(`${metaAlias}.source = $${idx++}`);
    params.push(filter.source);
  }
  if (filter?.project) {
    clauses.push(`${metaAlias}.project = $${idx++}`);
    params.push(filter.project);
  }
  if (typeof filter?.fromMs === "number") {
    clauses.push(`${tableAlias}.created_at >= $${idx++}`);
    params.push(filter.fromMs);
  }
  if (typeof filter?.toMs === "number") {
    clauses.push(`${tableAlias}.created_at <= $${idx++}`);
    params.push(filter.toMs);
  }
  return {
    clauses: clauses.length > 0 ? " AND " + clauses.join(" AND ") : "",
    params,
    nextIdx: idx,
  };
}

// ---------------------------------------------------------------------------
// PgDatabaseProvider
// ---------------------------------------------------------------------------

export class PgDatabaseProvider implements DatabaseProvider {
  readonly backendType = "postgres" as const;
  private pool!: Pool;
  private dim: number;
  private config: PostgresBackendConfig;

  constructor(config: PostgresBackendConfig) {
    this.config = config;
    this.dim = config.embeddingDimension ?? 3072;
  }

  async initialize(): Promise<void> {
    // Lazy-load pg to avoid requiring it when using SQLite
    const pg = await import("pg");
    this.pool = new pg.Pool({
      connectionString: this.config.connectionString,
      ssl: this.config.ssl ? { rejectUnauthorized: false } : undefined,
      max: this.config.poolSize ?? 5,
    });

    // Create schema + run migrations
    const client = await this.pool.connect();
    try {
      await client.query(getSchemaSQL(this.dim));
      await client.query(getMigrationsSQL());
    } finally {
      client.release();
    }
  }

  /** Ensure the IVFFlat vector index exists (requires data in the table). */
  /** Ensure the HNSW halfvec vector index exists. */
  async ensureVectorIndex(): Promise<void> {
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS idx_chunks_embedding
        ON chunks USING hnsw ((embedding::halfvec(${this.dim})) halfvec_cosine_ops);
    `);
  }

  // -- Session meta ----------------------------------------------------------

  async getSessionMeta(sessionId: string): Promise<SessionMeta | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM sessions_meta WHERE session_id = $1",
      [sessionId],
    );
    return rows.length > 0 ? this.toSessionMeta(rows[0]) : null;
  }

  async upsertSessionMeta(meta: SessionMeta): Promise<void> {
    await this.pool.query(`
      INSERT INTO sessions_meta (session_id, session_title, project, source,
        last_indexed_message_id, updated_at, transcript_path)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (session_id) DO UPDATE SET
        session_title           = EXCLUDED.session_title,
        project                 = EXCLUDED.project,
        source                  = EXCLUDED.source,
        last_indexed_message_id = EXCLUDED.last_indexed_message_id,
        updated_at              = EXCLUDED.updated_at,
        transcript_path         = COALESCE(EXCLUDED.transcript_path, sessions_meta.transcript_path)
    `, [
      meta.session_id, meta.session_title, meta.project, meta.source,
      meta.last_indexed_message_id, meta.updated_at, meta.transcript_path ?? null,
    ]);
  }

  // -- Chunk CRUD ------------------------------------------------------------

  async insertChunks(chunks: DocumentChunk[], embeddings: number[][]): Promise<void> {
    if (chunks.length !== embeddings.length) {
      throw new Error(`Mismatch: ${chunks.length} chunks but ${embeddings.length} embeddings`);
    }
    if (chunks.length === 0) return;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (let i = 0; i < chunks.length; i++) {
        const { metadata: m } = chunks[i];
        await client.query(`
          INSERT INTO chunks (embedding, chunk_id, content, session_id, session_title,
            project, heading_hierarchy, section, url, hash,
            chunk_index, total_chunks, message_order, created_at)
          VALUES ($1::vector, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
          ON CONFLICT (chunk_id) DO NOTHING
        `, [
          toVectorLiteral(embeddings[i]),
          m.chunk_id, chunks[i].content, m.session_id, m.session_title,
          m.project, JSON.stringify(m.heading_hierarchy), m.section, m.url, m.hash,
          m.chunk_index, m.total_chunks, m.message_order ?? 0, m.created_at ?? Date.now(),
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

  // -- Analytics insertion ----------------------------------------------------

  async insertMessages(rows: MessageRow[]): Promise<void> {
    if (rows.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const r of rows) {
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
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async insertToolCalls(rows: ToolCallRow[]): Promise<void> {
    if (rows.length === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const r of rows) {
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
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async deleteToolCallsBySession(sessionId: string): Promise<void> {
    await this.pool.query("DELETE FROM tool_calls WHERE session_id = $1", [sessionId]);
  }

  // -- Vector query ----------------------------------------------------------

  async queryByEmbedding(
    queryEmbedding: number[],
    topK: number,
    filters: QueryFilters,
  ): Promise<QueryResult[]> {
    const hasSectionFilter = !!(
      filters.sectionFilter ||
      filters.sectionOpts?.includeSections?.length ||
      filters.sectionOpts?.excludeSections?.length
    );
    const knnK = hasSectionFilter ? topK * 5 : topK;

    const params: unknown[] = [toVectorLiteral(queryEmbedding)];
    let idx = 2;
    let sql = `
      SELECT c.chunk_id, c.content, c.url, c.section, c.heading_hierarchy,
             c.chunk_index, c.total_chunks, c.session_id, c.session_title, c.project,
             c.created_at, m.source,
             (c.embedding::halfvec(${this.dim}) <=> $1::halfvec(${this.dim})) AS distance
      FROM chunks c
      LEFT JOIN sessions_meta m ON c.session_id = m.session_id
      WHERE 1=1
    `;

    if (filters.projectFilter) {
      sql += ` AND c.project = $${idx++}`;
      params.push(filters.projectFilter);
    }
    if (filters.sourceFilter) {
      sql += ` AND m.source = $${idx++}`;
      params.push(filters.sourceFilter);
    }
    if (typeof filters.fromMs === "number") {
      sql += ` AND c.created_at >= $${idx++}`;
      params.push(filters.fromMs);
    }
    if (typeof filters.toMs === "number") {
      sql += ` AND c.created_at <= $${idx++}`;
      params.push(filters.toMs);
    }

    const sf = appendSectionFilters(sql, params, "c.section", {
      sectionFilter: filters.sectionFilter,
      sectionOpts: filters.sectionOpts,
    });
    sql = sf.sql;

    sql += ` ORDER BY distance LIMIT $${params.length + 1}`;
    params.push(knnK);

    const { rows } = await this.pool.query(sql, params);
    const results = rows.map(this.toQueryResult);
    return results.slice(0, topK);
  }

  // -- Keyword query ----------------------------------------------------------

  async queryByKeyword(
    queryText: string,
    topK: number,
    filters: QueryFilters,
  ): Promise<QueryResult[]> {
    const sanitized = queryText.replace(/['"*(){}[\]:^~!\\]/g, " ").trim();
    if (!sanitized) return [];

    const params: unknown[] = [sanitized];
    let idx = 2;
    let sql = `
      SELECT c.chunk_id, c.content, c.url, c.section, c.heading_hierarchy,
             c.chunk_index, c.total_chunks, c.session_id, c.session_title, c.project,
             c.created_at, m.source,
             ts_rank(c.content_tsv, plainto_tsquery('simple', $1)) AS rank
      FROM chunks c
      LEFT JOIN sessions_meta m ON c.session_id = m.session_id
      WHERE c.content_tsv @@ plainto_tsquery('simple', $1)
    `;

    if (filters.projectFilter) {
      sql += ` AND c.project = $${idx++}`;
      params.push(filters.projectFilter);
    }
    if (filters.sourceFilter) {
      sql += ` AND m.source = $${idx++}`;
      params.push(filters.sourceFilter);
    }
    if (typeof filters.fromMs === "number") {
      sql += ` AND c.created_at >= $${idx++}`;
      params.push(filters.fromMs);
    }
    if (typeof filters.toMs === "number") {
      sql += ` AND c.created_at <= $${idx++}`;
      params.push(filters.toMs);
    }

    const sf = appendSectionFilters(sql, params, "c.section", {
      sectionFilter: filters.sectionFilter,
      sectionOpts: filters.sectionOpts,
    });
    sql = sf.sql;

    sql += ` ORDER BY rank DESC LIMIT $${params.length + 1}`;
    params.push(topK);

    try {
      const { rows } = await this.pool.query(sql, params);
      return rows.map(this.toQueryResult);
    } catch {
      return [];
    }
  }

  // -- Hybrid query -----------------------------------------------------------

  async queryHybrid(
    queryEmbedding: number[],
    queryText: string,
    topK: number,
    filters: QueryFilters,
  ): Promise<QueryResult[]> {
    const overFetch = topK * 3;
    const [vectorResults, keywordResults] = await Promise.all([
      this.queryByEmbedding(queryEmbedding, overFetch, filters),
      this.queryByKeyword(queryText, overFetch, filters),
    ]);

    const K = 60;
    const scores = new Map<string, { score: number; result: QueryResult }>();

    for (let i = 0; i < vectorResults.length; i++) {
      const r = vectorResults[i];
      scores.set(r.chunk_id, { score: 1 / (K + i + 1), result: r });
    }
    for (let i = 0; i < keywordResults.length; i++) {
      const r = keywordResults[i];
      const existing = scores.get(r.chunk_id);
      if (existing) {
        existing.score += 1 / (K + i + 1);
      } else {
        scores.set(r.chunk_id, { score: 1 / (K + i + 1), result: r });
      }
    }

    return Array.from(scores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((e) => e.result);
  }

  // -- Chunk retrieval --------------------------------------------------------

  async getChunksByUrl(url: string, startIndex?: number, endIndex?: number): Promise<QueryResult[]> {
    const params: unknown[] = [url];
    let idx = 2;
    let sql = `
      SELECT chunk_id, content, url, section, heading_hierarchy, chunk_index, total_chunks
      FROM chunks WHERE url = $1
    `;
    if (typeof startIndex === "number") {
      sql += ` AND chunk_index >= $${idx++}`;
      params.push(startIndex);
    }
    if (typeof endIndex === "number") {
      sql += ` AND chunk_index <= $${idx++}`;
      params.push(endIndex);
    }
    sql += " ORDER BY chunk_index";
    const { rows } = await this.pool.query(sql, params);
    return rows as QueryResult[];
  }

  async getSessionContext(sessionId: string, chunkId: string, windowSize = 1): Promise<QueryResult[]> {
    const { rows: allChunks } = await this.pool.query(`
      SELECT chunk_id, content, url, section, heading_hierarchy,
             chunk_index, total_chunks, created_at
      FROM chunks
      WHERE session_id = $1
      ORDER BY created_at, chunk_index
    `, [sessionId]);

    const targetIdx = allChunks.findIndex((c: { chunk_id: string }) => c.chunk_id === chunkId);
    if (targetIdx === -1) return [];
    const start = Math.max(0, targetIdx - windowSize);
    const end = Math.min(allChunks.length - 1, targetIdx + windowSize);
    return allChunks.slice(start, end + 1) as QueryResult[];
  }

  async listSessionUrls(sessionId: string): Promise<string[]> {
    const { rows } = await this.pool.query(
      "SELECT DISTINCT url FROM chunks WHERE session_id = $1 ORDER BY url",
      [sessionId],
    );
    return rows.map((r: { url: string }) => r.url);
  }

  async getSessionChunksOrdered(sessionId: string): Promise<ChunkRow[]> {
    const { rows } = await this.pool.query(`
      SELECT chunk_id, chunk_index, total_chunks, section, heading_hierarchy, content, url
      FROM chunks
      WHERE session_id = $1
      ORDER BY message_order ASC, chunk_index ASC
    `, [sessionId]);
    return rows as ChunkRow[];
  }

  // -- Session management -----------------------------------------------------

  async listSessions(filter: SessionFilter = {}): Promise<SessionRow[]> {
    const params: unknown[] = [];
    let idx = 1;
    let sql = `
      SELECT
        m.session_id, m.session_title, m.project, m.source,
        m.last_indexed_message_id, m.updated_at,
        COUNT(c.chunk_id) AS chunk_count
      FROM sessions_meta m
      LEFT JOIN chunks c ON c.session_id = m.session_id
      WHERE 1=1
    `;

    if (filter.source) {
      sql += ` AND m.source = $${idx++}`;
      params.push(filter.source);
    }
    if (typeof filter.fromDate === "number") {
      sql += ` AND m.updated_at >= $${idx++}`;
      params.push(filter.fromDate);
    }
    if (typeof filter.toDate === "number") {
      sql += ` AND m.updated_at <= $${idx++}`;
      params.push(filter.toDate);
    }

    sql += " GROUP BY m.session_id ORDER BY m.updated_at DESC";
    const { rows } = await this.pool.query(sql, params);
    return rows.map((r: Record<string, unknown>) => ({
      ...this.toSessionMeta(r),
      chunk_count: Number(r.chunk_count),
    })) as SessionRow[];
  }

  async deleteSession(sessionId: string): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const { rowCount } = await client.query("DELETE FROM chunks WHERE session_id = $1", [sessionId]);
      await client.query("DELETE FROM tool_calls WHERE session_id = $1", [sessionId]);
      await client.query("DELETE FROM messages WHERE session_id = $1", [sessionId]);
      await client.query("DELETE FROM sessions_meta WHERE session_id = $1", [sessionId]);
      await client.query("COMMIT");
      return rowCount ?? 0;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  async deleteSessionsOlderThan(olderThanMs: number): Promise<{ sessions: number; chunks: number }> {
    const candidates = await this.listSessions({ toDate: olderThanMs });
    if (candidates.length === 0) return { sessions: 0, chunks: 0 };

    const client = await this.pool.connect();
    let totalChunks = 0;
    try {
      await client.query("BEGIN");
      for (const s of candidates) {
        const { rowCount } = await client.query("DELETE FROM chunks WHERE session_id = $1", [s.session_id]);
        totalChunks += rowCount ?? 0;
        await client.query("DELETE FROM tool_calls WHERE session_id = $1", [s.session_id]);
        await client.query("DELETE FROM messages WHERE session_id = $1", [s.session_id]);
        await client.query("DELETE FROM sessions_meta WHERE session_id = $1", [s.session_id]);
      }
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }

    return { sessions: candidates.length, chunks: totalChunks };
  }

  // -- Analytics queries ------------------------------------------------------

  async getToolUsageStats(filter?: AnalyticsFilter): Promise<ToolUsageStat[]> {
    const { clauses, params } = buildAnalyticsWhere(filter, "t", "m");
    const { rows } = await this.pool.query(`
      SELECT
        t.tool_name,
        COUNT(*)::int                     AS call_count,
        SUM(t.has_error)::int             AS error_count,
        COUNT(DISTINCT t.session_id)::int AS session_count
      FROM tool_calls t
      JOIN sessions_meta m ON t.session_id = m.session_id
      WHERE 1=1${clauses}
      GROUP BY t.tool_name
      ORDER BY call_count DESC
    `, params);
    return rows as ToolUsageStat[];
  }

  async getMessageStats(filter?: AnalyticsFilter): Promise<MessageStat[]> {
    const { clauses, params } = buildAnalyticsWhere(filter, "msg", "m");
    const { rows } = await this.pool.query(`
      SELECT msg.role, COUNT(*)::int AS count
      FROM messages msg
      JOIN sessions_meta m ON msg.session_id = m.session_id
      WHERE 1=1${clauses}
      GROUP BY msg.role
      ORDER BY count DESC
    `, params);
    return rows as MessageStat[];
  }

  async getOverviewStats(filter?: AnalyticsFilter): Promise<OverviewStats> {
    const { clauses: msgClauses, params: msgParams } = buildAnalyticsWhere(filter, "msg", "m");
    const msgResult = await this.pool.query(`
      SELECT
        COUNT(DISTINCT msg.session_id)::int AS total_sessions,
        COUNT(*)::int                       AS total_messages,
        MIN(msg.created_at)                 AS earliest_message_at,
        MAX(msg.created_at)                 AS latest_message_at
      FROM messages msg
      JOIN sessions_meta m ON msg.session_id = m.session_id
      WHERE 1=1${msgClauses}
    `, msgParams);
    const msgStats = msgResult.rows[0];

    const { clauses: tcClauses, params: tcParams } = buildAnalyticsWhere(filter, "t", "m");
    const tcResult = await this.pool.query(`
      SELECT COUNT(*)::int AS total_tool_calls
      FROM tool_calls t
      JOIN sessions_meta m ON t.session_id = m.session_id
      WHERE 1=1${tcClauses}
    `, tcParams);
    const tcStats = tcResult.rows[0];

    return {
      total_sessions: msgStats.total_sessions,
      total_messages: msgStats.total_messages,
      total_tool_calls: tcStats.total_tool_calls,
      earliest_message_at: msgStats.earliest_message_at ? Number(msgStats.earliest_message_at) : null,
      latest_message_at: msgStats.latest_message_at ? Number(msgStats.latest_message_at) : null,
    };
  }

  async getSessionAnalytics(sessionId: string): Promise<SessionAnalytics | null> {
    const msgCount = await this.pool.query(
      "SELECT COUNT(*)::int AS cnt FROM messages WHERE session_id = $1",
      [sessionId],
    );
    if (msgCount.rows[0].cnt === 0) return null;

    const tcCount = await this.pool.query(
      "SELECT COUNT(*)::int AS cnt FROM tool_calls WHERE session_id = $1",
      [sessionId],
    );

    const duration = await this.pool.query(`
      WITH ordered AS (
        SELECT created_at,
               LEAD(created_at) OVER (ORDER BY message_order) AS next_at
        FROM messages
        WHERE session_id = $1 AND created_at IS NOT NULL
      )
      SELECT COALESCE(SUM(
        CASE WHEN next_at - created_at <= 1800000
             THEN next_at - created_at
             ELSE 0
        END
      ), 0)::bigint AS approx_duration_ms
      FROM ordered
      WHERE next_at IS NOT NULL
    `, [sessionId]);

    const messagesByRole = await this.pool.query(`
      SELECT role, COUNT(*)::int AS count
      FROM messages WHERE session_id = $1
      GROUP BY role ORDER BY count DESC
    `, [sessionId]);

    const toolBreakdown = await this.pool.query(`
      SELECT
        tool_name,
        COUNT(*)::int       AS call_count,
        SUM(has_error)::int AS error_count,
        1                   AS session_count
      FROM tool_calls WHERE session_id = $1
      GROUP BY tool_name ORDER BY call_count DESC
    `, [sessionId]);

    return {
      session_id: sessionId,
      message_count: msgCount.rows[0].cnt,
      tool_call_count: tcCount.rows[0].cnt,
      approx_duration_ms: duration.rows[0]?.approx_duration_ms
        ? Number(duration.rows[0].approx_duration_ms)
        : null,
      messages_by_role: messagesByRole.rows as MessageStat[],
      tool_breakdown: toolBreakdown.rows as ToolUsageStat[],
    };
  }

  // -- Lifecycle --------------------------------------------------------------

  async checkpoint(): Promise<void> {
    // No-op for Postgres (no WAL checkpoint equivalent needed)
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // -- Row mappers ------------------------------------------------------------

  private toSessionMeta(row: Record<string, unknown>): SessionMeta {
    return {
      session_id: row.session_id as string,
      session_title: row.session_title as string,
      project: row.project as string,
      source: (row.source as string) as SessionMeta["source"],
      last_indexed_message_id: (row.last_indexed_message_id as string | null) ?? null,
      updated_at: Number(row.updated_at),
      transcript_path: (row.transcript_path as string | null) ?? null,
    };
  }

  private toQueryResult(row: Record<string, unknown>): QueryResult {
    return {
      chunk_id: row.chunk_id as string,
      distance: row.distance !== undefined ? Number(row.distance) : undefined,
      content: row.content as string,
      url: row.url as string | undefined,
      section: row.section as string | undefined,
      heading_hierarchy: row.heading_hierarchy as string | undefined,
      chunk_index: row.chunk_index !== undefined ? Number(row.chunk_index) : undefined,
      total_chunks: row.total_chunks !== undefined ? Number(row.total_chunks) : undefined,
      session_id: row.session_id as string | undefined,
      session_title: row.session_title as string | undefined,
      source: row.source as QueryResult["source"],
      created_at: row.created_at !== undefined ? Number(row.created_at) : undefined,
    };
  }
}
