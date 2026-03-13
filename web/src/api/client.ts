const BASE = "/api";

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
  source?: string;
  created_at?: number;
}

export interface SessionRow {
  session_id: string;
  session_title: string;
  project: string;
  source: string;
  last_indexed_message_id: string | null;
  updated_at: number;
  chunk_count: number;
}

export interface ChunkRow {
  chunk_id: string;
  chunk_index: number;
  total_chunks: number;
  section: string;
  heading_hierarchy: string;
  content: string;
  url: string;
}

export interface ToolStatus {
  installed: boolean;
  components: Array<{ name: string; ok: boolean; path: string }>;
}

export interface StatusResult {
  dbPath: string;
  dbExists: boolean;
  dbSizeBytes: number;
  totalSessions: number;
  totalChunks: number;
  sessionsBySource: Array<{ source: string; count: number }>;
  tools: Record<string, ToolStatus>;
  allOk: boolean;
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

export async function searchSessions(params: {
  queryText: string;
  source?: string;
  limit?: number;
  fromDate?: string;
  toDate?: string;
  sectionFilter?: string;
  hybrid?: boolean;
}): Promise<{ results: QueryResult[] }> {
  const res = await fetch(`${BASE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  return handleResponse(res);
}

export async function getChunkContext(
  sessionId: string,
  chunkId: string,
  window = 1,
): Promise<{ chunks: ChunkRow[] }> {
  const params = new URLSearchParams({
    sessionId,
    chunkId,
    window: String(window),
  });
  const res = await fetch(`${BASE}/context?${params}`);
  return handleResponse(res);
}

export async function getSessions(params?: {
  source?: string;
  from?: string;
  to?: string;
}): Promise<{ sessions: SessionRow[] }> {
  const query = new URLSearchParams();
  if (params?.source) query.set("source", params.source);
  if (params?.from) query.set("from", params.from);
  if (params?.to) query.set("to", params.to);
  const qs = query.toString();
  const res = await fetch(`${BASE}/sessions${qs ? "?" + qs : ""}`);
  return handleResponse(res);
}

export async function getSession(id: string): Promise<{
  session: SessionRow | null;
  chunks: ChunkRow[];
}> {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(id)}`);
  return handleResponse(res);
}

export async function deleteSessionById(id: string): Promise<{ deleted: number }> {
  const res = await fetch(`${BASE}/sessions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  return handleResponse(res);
}

export async function bulkDeleteSessions(ids: string[]): Promise<{ deleted: number }> {
  const res = await fetch(`${BASE}/sessions/bulk-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  return handleResponse(res);
}

export async function purgeOldSessions(days: number): Promise<{ sessions: number; chunks: number }> {
  const res = await fetch(`${BASE}/sessions/purge`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ days }),
  });
  return handleResponse(res);
}

export async function getStatus(): Promise<StatusResult> {
  const res = await fetch(`${BASE}/status`);
  return handleResponse(res);
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface ToolUsageStat {
  tool_name: string;
  call_count: number;
  error_count: number;
  session_count: number;
}

export interface MessageStat {
  role: string;
  count: number;
}

export interface OverviewStats {
  total_sessions: number;
  total_messages: number;
  total_tool_calls: number;
  earliest_message_at: number | null;
  latest_message_at: number | null;
}

export interface SessionAnalytics {
  session_id: string;
  message_count: number;
  tool_call_count: number;
  approx_duration_ms: number | null;
  messages_by_role: MessageStat[];
  tool_breakdown: ToolUsageStat[];
}

export interface AnalyticsParams {
  source?: string;
  from?: string;
  to?: string;
}

function analyticsQuery(params?: AnalyticsParams): string {
  const q = new URLSearchParams();
  if (params?.source) q.set("source", params.source);
  if (params?.from) q.set("from", params.from);
  if (params?.to) q.set("to", params.to);
  const qs = q.toString();
  return qs ? "?" + qs : "";
}

export async function getAnalyticsOverview(params?: AnalyticsParams): Promise<OverviewStats> {
  const res = await fetch(`${BASE}/analytics/overview${analyticsQuery(params)}`);
  return handleResponse(res);
}

export async function getAnalyticsTools(params?: AnalyticsParams): Promise<{ tools: ToolUsageStat[] }> {
  const res = await fetch(`${BASE}/analytics/tools${analyticsQuery(params)}`);
  return handleResponse(res);
}

export async function getAnalyticsMessages(params?: AnalyticsParams): Promise<{ messages: MessageStat[] }> {
  const res = await fetch(`${BASE}/analytics/messages${analyticsQuery(params)}`);
  return handleResponse(res);
}

export async function getSessionAnalytics(id: string): Promise<SessionAnalytics> {
  const res = await fetch(`${BASE}/analytics/session/${encodeURIComponent(id)}`);
  return handleResponse(res);
}
