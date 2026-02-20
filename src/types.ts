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
  };
}

/**
 * A row in the sessions_meta table — tracks per-session indexing progress.
 */
export interface SessionMeta {
  session_id: string;
  session_title: string;
  project: string;
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
  role: "user" | "assistant";
  time?: { created?: number; completed?: number };
  agent?: string;
  modelID?: string;
}

export interface MessagePart {
  type: string;
  text?: string;
  // tool invocation fields
  toolName?: string;
  toolCallId?: string;
  state?: string;
  args?: unknown;
  result?: unknown;
  // file fields
  filename?: string;
  mediaType?: string;
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
}

/**
 * Config for the database layer.
 */
export interface DatabaseConfig {
  dbPath: string;
  embeddingDimension?: number;
}
