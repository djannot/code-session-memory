import type { SessionRow, ChunkRow, SessionAnalytics } from "../api/client";
import SourceBadge from "./SourceBadge";
import ChunkView from "./ChunkView";

function formatDate(unixMs: number): string {
  if (!unixMs) return "\u2014";
  return new Date(unixMs).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(ms: number | null): string {
  if (!ms || ms <= 0) return "\u2014";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

const roleColors: Record<string, string> = {
  user: "bg-blue-100 text-blue-700",
  assistant: "bg-emerald-100 text-emerald-700",
  tool: "bg-amber-100 text-amber-700",
};

interface SessionDetailProps {
  session: SessionRow;
  chunks: ChunkRow[];
  analytics?: SessionAnalytics | null;
  onDelete: () => void;
  highlightedChunkId?: string | null;
}

export default function SessionDetail({ session, chunks, analytics, onDelete, highlightedChunkId }: SessionDetailProps) {
  return (
    <div>
      {/* Header */}
      <div className="glass-strong rounded-xl p-5 mb-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-gray-900 mb-2 truncate">
              {session.session_title || "(untitled)"}
            </h1>
            <div className="flex flex-wrap items-center gap-3 text-sm text-gray-500">
              <SourceBadge source={session.source} />
              <span>{formatDate(session.updated_at)}</span>
              <span className="text-gray-400">{chunks.length} chunks</span>
            </div>
            <div className="mt-2 text-xs text-gray-500 font-mono">
              <span className="text-gray-400">Project:</span> {session.project || "\u2014"}
            </div>
            <div className="text-xs text-gray-400 font-mono mt-1">
              ID: {session.session_id}
            </div>
          </div>
          <button
            onClick={onDelete}
            className="shrink-0 px-3 py-1.5 text-xs rounded-lg border border-red-300/50 text-red-600 hover:bg-red-100/40 transition-colors cursor-pointer"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Analytics stats */}
      {analytics && (
        <div className="glass rounded-xl p-4 mb-6 shadow-sm">
          <div className="flex flex-wrap gap-3 items-center">
            {/* Message counts by role */}
            {analytics.messages_by_role.filter((m) => m.role !== "tool").map((m) => (
              <span
                key={m.role}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${roleColors[m.role] || "bg-gray-100 text-gray-700"}`}
              >
                <span className="capitalize">{m.role}</span>
                <span className="font-semibold">{m.count}</span>
              </span>
            ))}

            <span className="w-px h-4 bg-gray-300" />

            {/* Tool calls total */}
            <span className="text-xs text-gray-600">
              <span className="font-semibold">{analytics.tool_call_count}</span> tool calls
            </span>

            {/* Duration */}
            {analytics.approx_duration_ms != null && analytics.approx_duration_ms > 0 && (
              <>
                <span className="w-px h-4 bg-gray-300" />
                <span className="text-xs text-gray-600">
                  ~{formatDuration(analytics.approx_duration_ms)}
                </span>
              </>
            )}
          </div>

          {/* Tool breakdown */}
          {analytics.tool_breakdown.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {analytics.tool_breakdown.map((t) => (
                <span
                  key={t.tool_name}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-violet-50 text-violet-700 text-xs font-mono"
                >
                  {t.tool_name}
                  <span className="text-violet-400">{t.call_count}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Chunks */}
      <div className="space-y-3">
        {chunks.map((chunk, i) => (
          <ChunkView key={chunk.chunk_id} chunk={chunk} index={i} total={chunks.length} highlighted={chunk.chunk_id === highlightedChunkId} />
        ))}
      </div>
    </div>
  );
}
