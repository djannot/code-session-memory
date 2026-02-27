import { useNavigate } from "react-router-dom";
import type { QueryResult } from "../api/client";
import SourceBadge from "./SourceBadge";

function formatDate(unixMs?: number): string {
  if (!unixMs) return "";
  return new Date(unixMs).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function SearchResultCard({
  result,
  index,
}: {
  result: QueryResult;
  index: number;
}) {
  const navigate = useNavigate();
  const content = (result.content ?? "").trim();
  const truncated = content.length > 500 ? content.slice(0, 500) + "..." : content;

  return (
    <div
      onClick={() => result.session_id && navigate(`/sessions/${encodeURIComponent(result.session_id)}`)}
      className="group bg-slate-900/50 border border-slate-800 rounded-xl p-4 hover:border-slate-700 hover:bg-slate-900 transition-all cursor-pointer"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono text-slate-600">{index}</span>
          <h3 className="text-sm font-medium text-slate-200 truncate">
            {result.session_title || "(untitled)"}
          </h3>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {typeof result.distance === "number" && (
            <span className="text-xs font-mono text-slate-600">
              {result.distance.toFixed(4)}
            </span>
          )}
          {result.source && <SourceBadge source={result.source} />}
        </div>
      </div>

      {result.section && (
        <div className="text-xs text-slate-500 mb-2">{result.section}</div>
      )}

      <pre className="text-xs text-slate-400 whitespace-pre-wrap break-words font-mono bg-slate-950/50 rounded-lg p-3 max-h-40 overflow-hidden">
        {truncated}
      </pre>

      <div className="flex items-center gap-3 mt-2 text-xs text-slate-600">
        {result.created_at && <span>{formatDate(result.created_at)}</span>}
        {typeof result.chunk_index === "number" && typeof result.total_chunks === "number" && (
          <span>
            Chunk {result.chunk_index + 1}/{result.total_chunks}
          </span>
        )}
      </div>
    </div>
  );
}
