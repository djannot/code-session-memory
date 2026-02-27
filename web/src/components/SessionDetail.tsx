import type { SessionRow, ChunkRow } from "../api/client";
import SourceBadge from "./SourceBadge";
import ChunkView from "./ChunkView";

function formatDate(unixMs: number): string {
  if (!unixMs) return "—";
  return new Date(unixMs).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface SessionDetailProps {
  session: SessionRow;
  chunks: ChunkRow[];
  onDelete: () => void;
}

export default function SessionDetail({ session, chunks, onDelete }: SessionDetailProps) {
  return (
    <div>
      {/* Header */}
      <div className="bg-slate-900/50 border border-slate-800 rounded-xl p-5 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-slate-100 mb-2 truncate">
              {session.session_title || "(untitled)"}
            </h1>
            <div className="flex flex-wrap items-center gap-3 text-sm text-slate-400">
              <SourceBadge source={session.source} />
              <span>{formatDate(session.updated_at)}</span>
              <span className="text-slate-600">{chunks.length} chunks</span>
            </div>
            <div className="mt-2 text-xs text-slate-500 font-mono">
              <span className="text-slate-600">Project:</span> {session.project || "—"}
            </div>
            <div className="text-xs text-slate-600 font-mono mt-1">
              ID: {session.session_id}
            </div>
          </div>
          <button
            onClick={onDelete}
            className="shrink-0 px-3 py-1.5 text-xs rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Chunks */}
      <div className="space-y-3">
        {chunks.map((chunk, i) => (
          <ChunkView key={chunk.chunk_id} chunk={chunk} index={i} total={chunks.length} />
        ))}
      </div>
    </div>
  );
}
