import type {
  DocumentChunk, SessionMeta, SessionSource, QueryResult,
  MessageRow, ToolCallRow, AnalyticsFilter, ToolUsageStat, MessageStat,
  OverviewStats, SessionAnalytics,
} from "../types";
import type { SectionFilterOptions, SessionRow, SessionFilter, ChunkRow } from "../database";

// ---------------------------------------------------------------------------
// Query filter options (passed to query methods)
// ---------------------------------------------------------------------------

export interface QueryFilters {
  projectFilter?: string;
  sourceFilter?: SessionSource;
  fromMs?: number;
  toMs?: number;
  sectionFilter?: string;
  sectionOpts?: SectionFilterOptions;
}

// ---------------------------------------------------------------------------
// DatabaseProvider — the unified async interface for all backends
// ---------------------------------------------------------------------------

export interface DatabaseProvider {
  /** Human-readable backend name ("sqlite" | "postgres") */
  readonly backendType: "sqlite" | "postgres";

  // -- Session meta ----------------------------------------------------------
  getSessionMeta(sessionId: string): Promise<SessionMeta | null>;
  upsertSessionMeta(meta: SessionMeta): Promise<void>;

  // -- Chunk CRUD ------------------------------------------------------------
  insertChunks(chunks: DocumentChunk[], embeddings: number[][]): Promise<void>;

  // -- Analytics insertion ----------------------------------------------------
  insertMessages(rows: MessageRow[]): Promise<void>;
  insertToolCalls(rows: ToolCallRow[]): Promise<void>;
  deleteToolCallsBySession(sessionId: string): Promise<void>;

  // -- Vector / keyword / hybrid queries --------------------------------------
  queryByEmbedding(
    queryEmbedding: number[],
    topK: number,
    filters: QueryFilters,
  ): Promise<QueryResult[]>;

  queryByKeyword(
    queryText: string,
    topK: number,
    filters: QueryFilters,
  ): Promise<QueryResult[]>;

  queryHybrid(
    queryEmbedding: number[],
    queryText: string,
    topK: number,
    filters: QueryFilters,
  ): Promise<QueryResult[]>;

  // -- Chunk retrieval --------------------------------------------------------
  getChunksByUrl(url: string, startIndex?: number, endIndex?: number): Promise<QueryResult[]>;
  getSessionContext(sessionId: string, chunkId: string, windowSize?: number): Promise<QueryResult[]>;
  listSessionUrls(sessionId: string): Promise<string[]>;
  getSessionChunksOrdered(sessionId: string): Promise<ChunkRow[]>;

  // -- Session management -----------------------------------------------------
  listSessions(filter?: SessionFilter): Promise<SessionRow[]>;
  deleteSession(sessionId: string): Promise<number>;
  deleteSessionsOlderThan(olderThanMs: number): Promise<{ sessions: number; chunks: number }>;

  // -- Analytics queries ------------------------------------------------------
  getToolUsageStats(filter?: AnalyticsFilter): Promise<ToolUsageStat[]>;
  getMessageStats(filter?: AnalyticsFilter): Promise<MessageStat[]>;
  getOverviewStats(filter?: AnalyticsFilter): Promise<OverviewStats>;
  getSessionAnalytics(sessionId: string): Promise<SessionAnalytics | null>;

  // -- Lifecycle --------------------------------------------------------------
  /** Flush / checkpoint (no-op for Postgres). */
  checkpoint(): Promise<void>;
  close(): Promise<void>;
}
