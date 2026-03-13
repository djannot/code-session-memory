/**
 * A single chunk of content ready to be embedded and stored.
 */
export interface DocumentChunk {
  content: string;
  metadata: {
    session_id: string;
    session_title: string;
    project: string;
    heading_hierarchy: string[];
    section: string;
    chunk_id: string;
    url: string;
    hash: string;
    chunk_index: number;
    total_chunks: number;
    /** 0-based position of this message within the session (set at index time). Used for correct print ordering. */
    message_order?: number;
    /** Unix ms timestamp set at insert time (Date.now()). Used for date filtering. */
    created_at?: number;
  };
}

/**
 * Which tool produced a session.
 */
export type SessionSource = "opencode" | "claude-code" | "cursor" | "vscode" | "codex" | "gemini-cli";

/**
 * A row in the sessions_meta table — tracks per-session indexing progress.
 */
export interface SessionMeta {
  session_id: string;
  session_title: string;
  project: string;
  source: SessionSource;
  last_indexed_message_id: string | null;
  updated_at: number;
}

/**
 * Minimal session info shape (subset of OpenCode SDK Session type).
 */
export interface SessionInfo {
  id: string;
  title?: string;
  directory?: string;
}

/**
 * Minimal message shape used by the indexer (subset of OpenCode SDK types).
 */
export interface MessageInfo {
  id: string;
  role: "user" | "assistant" | "tool";
  time?: { created?: number; completed?: number };
  agent?: string;
  modelID?: string;
}

export interface MessagePart {
  type: string;
  text?: string;
  // tool invocation fields (Claude Code: type="tool-invocation")
  toolName?: string;
  toolCallId?: string;
  state?: string | ToolState;
  args?: unknown;
  result?: unknown;
  // file fields
  filename?: string;
  mediaType?: string;
  // OpenCode tool part fields (type="tool")
  callID?: string;
  tool?: string;
}

/**
 * OpenCode tool part state — shape returned by the OpenCode REST API.
 */
export interface ToolState {
  status: "pending" | "running" | "complete" | "error";
  input?: unknown;
  output?: unknown;
  error?: string;
  title?: string;
}

export interface FullMessage {
  info: MessageInfo;
  parts: MessagePart[];
}

/**
 * Result row returned by the MCP server query tools.
 */
export interface QueryResult {
  chunk_id: string;
  distance?: number;
  content: string;
  url?: string;
  section?: string;
  heading_hierarchy?: string;
  chunk_index?: number;
  total_chunks?: number;
  session_id?: string;
  session_title?: string;
  source?: SessionSource;
  created_at?: number;
}

/**
 * Config for the database layer.
 */
export interface DatabaseConfig {
  dbPath: string;
  embeddingDimension?: number;
}

// ---------------------------------------------------------------------------
// Structured analytics tables
// ---------------------------------------------------------------------------

/**
 * A row in the `messages` table — one per message indexed.
 */
export interface MessageRow {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "tool";
  created_at: number | null;
  text_length: number;
  part_count: number;
  tool_call_count: number;
  message_order: number;
  indexed_at: number;
}

/**
 * A row in the `tool_calls` table — one per tool invocation extracted from messages.
 */
export interface ToolCallRow {
  message_id: string;
  session_id: string;
  tool_name: string;
  tool_call_id: string | null;
  status: string | null;
  has_error: number;
  args_length: number;
  result_length: number;
  created_at: number | null;
  indexed_at: number;
}

/**
 * Filter options for analytics queries.
 */
export interface AnalyticsFilter {
  source?: SessionSource;
  project?: string;
  fromMs?: number;
  toMs?: number;
}

/**
 * Tool usage statistics returned by getToolUsageStats().
 */
export interface ToolUsageStat {
  tool_name: string;
  call_count: number;
  error_count: number;
  session_count: number;
}

/**
 * Per-role message count returned by getMessageStats().
 */
export interface MessageStat {
  role: string;
  count: number;
}

/**
 * Overview statistics returned by getOverviewStats().
 */
export interface OverviewStats {
  total_sessions: number;
  total_messages: number;
  total_tool_calls: number;
  earliest_message_at: number | null;
  latest_message_at: number | null;
}

/**
 * Per-session analytics returned by getSessionAnalytics().
 */
export interface SessionAnalytics {
  session_id: string;
  message_count: number;
  tool_call_count: number;
  approx_duration_ms: number | null;
  messages_by_role: MessageStat[];
  tool_breakdown: ToolUsageStat[];
}
