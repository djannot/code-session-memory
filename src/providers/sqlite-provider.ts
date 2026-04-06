import type { DatabaseProvider, QueryFilters } from "./types";
import type {
  DocumentChunk, SessionMeta, QueryResult,
  MessageRow, ToolCallRow, AnalyticsFilter, ToolUsageStat, MessageStat,
  OverviewStats, SessionAnalytics,
} from "../types";
import type { SessionRow, SessionFilter, ChunkRow, Database } from "../database";
import {
  openDatabase,
  getSessionMeta as _getSessionMeta,
  upsertSessionMeta as _upsertSessionMeta,
  insertChunks as _insertChunks,
  insertMessages as _insertMessages,
  insertToolCalls as _insertToolCalls,
  queryByEmbedding as _queryByEmbedding,
  queryByKeyword as _queryByKeyword,
  queryHybrid as _queryHybrid,
  getChunksByUrl as _getChunksByUrl,
  getSessionContext as _getSessionContext,
  listSessionUrls as _listSessionUrls,
  getSessionChunksOrdered as _getSessionChunksOrdered,
  listSessions as _listSessions,
  deleteSession as _deleteSession,
  deleteSessionsOlderThan as _deleteSessionsOlderThan,
  getToolUsageStats as _getToolUsageStats,
  getMessageStats as _getMessageStats,
  getOverviewStats as _getOverviewStats,
  getSessionAnalytics as _getSessionAnalytics,
} from "../database";
import type { SqliteBackendConfig } from "../config";

/**
 * SQLite implementation of DatabaseProvider.
 * Thin async wrapper around the existing synchronous database.ts functions.
 */
export class SqliteDatabaseProvider implements DatabaseProvider {
  readonly backendType = "sqlite" as const;
  private db: Database;

  constructor(config: SqliteBackendConfig) {
    this.db = openDatabase({ dbPath: config.dbPath, embeddingDimension: config.embeddingDimension });
  }

  /** Expose the underlying SQLite connection for edge cases (e.g. raw SQL in migration). */
  getRawDb(): Database {
    return this.db;
  }

  // -- Session meta ----------------------------------------------------------

  async getSessionMeta(sessionId: string): Promise<SessionMeta | null> {
    return _getSessionMeta(this.db, sessionId);
  }

  async upsertSessionMeta(meta: SessionMeta): Promise<void> {
    _upsertSessionMeta(this.db, meta);
  }

  // -- Chunk CRUD ------------------------------------------------------------

  async insertChunks(chunks: DocumentChunk[], embeddings: number[][]): Promise<void> {
    _insertChunks(this.db, chunks, embeddings);
  }

  // -- Analytics insertion ----------------------------------------------------

  async insertMessages(rows: MessageRow[]): Promise<void> {
    _insertMessages(this.db, rows);
  }

  async insertToolCalls(rows: ToolCallRow[]): Promise<void> {
    _insertToolCalls(this.db, rows);
  }

  async deleteToolCallsBySession(sessionId: string): Promise<void> {
    this.db.prepare("DELETE FROM tool_calls WHERE session_id = ?").run(sessionId);
  }

  // -- Queries ---------------------------------------------------------------

  async queryByEmbedding(
    queryEmbedding: number[],
    topK: number,
    filters: QueryFilters,
  ): Promise<QueryResult[]> {
    return _queryByEmbedding(
      this.db, queryEmbedding, topK,
      filters.projectFilter, filters.sourceFilter,
      filters.fromMs, filters.toMs,
      filters.sectionFilter, filters.sectionOpts,
    );
  }

  async queryByKeyword(
    queryText: string,
    topK: number,
    filters: QueryFilters,
  ): Promise<QueryResult[]> {
    return _queryByKeyword(
      this.db, queryText, topK,
      filters.projectFilter, filters.sourceFilter,
      filters.fromMs, filters.toMs,
      filters.sectionFilter, filters.sectionOpts,
    );
  }

  async queryHybrid(
    queryEmbedding: number[],
    queryText: string,
    topK: number,
    filters: QueryFilters,
  ): Promise<QueryResult[]> {
    return _queryHybrid(
      this.db, queryEmbedding, queryText, topK,
      filters.projectFilter, filters.sourceFilter,
      filters.fromMs, filters.toMs,
      filters.sectionFilter, filters.sectionOpts,
    );
  }

  // -- Chunk retrieval --------------------------------------------------------

  async getChunksByUrl(url: string, startIndex?: number, endIndex?: number): Promise<QueryResult[]> {
    return _getChunksByUrl(this.db, url, startIndex, endIndex);
  }

  async getSessionContext(sessionId: string, chunkId: string, windowSize?: number): Promise<QueryResult[]> {
    return _getSessionContext(this.db, sessionId, chunkId, windowSize);
  }

  async listSessionUrls(sessionId: string): Promise<string[]> {
    return _listSessionUrls(this.db, sessionId);
  }

  async getSessionChunksOrdered(sessionId: string): Promise<ChunkRow[]> {
    return _getSessionChunksOrdered(this.db, sessionId);
  }

  // -- Session management -----------------------------------------------------

  async listSessions(filter?: SessionFilter): Promise<SessionRow[]> {
    return _listSessions(this.db, filter);
  }

  async deleteSession(sessionId: string): Promise<number> {
    return _deleteSession(this.db, sessionId);
  }

  async deleteSessionsOlderThan(olderThanMs: number): Promise<{ sessions: number; chunks: number }> {
    return _deleteSessionsOlderThan(this.db, olderThanMs);
  }

  // -- Analytics queries ------------------------------------------------------

  async getToolUsageStats(filter?: AnalyticsFilter): Promise<ToolUsageStat[]> {
    return _getToolUsageStats(this.db, filter);
  }

  async getMessageStats(filter?: AnalyticsFilter): Promise<MessageStat[]> {
    return _getMessageStats(this.db, filter);
  }

  async getOverviewStats(filter?: AnalyticsFilter): Promise<OverviewStats> {
    return _getOverviewStats(this.db, filter);
  }

  async getSessionAnalytics(sessionId: string): Promise<SessionAnalytics | null> {
    return _getSessionAnalytics(this.db, sessionId);
  }

  // -- Lifecycle --------------------------------------------------------------

  async checkpoint(): Promise<void> {
    this.db.pragma("wal_checkpoint(PASSIVE)");
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
