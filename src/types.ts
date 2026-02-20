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
export type SessionSource = "opencode" | "claude-code" | "cursor";

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
