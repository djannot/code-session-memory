import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { QueryResult, ChunkRow } from "../api/client";
import { getChunkContext } from "../api/client";
import SourceBadge from "./SourceBadge";
import ChunkView from "./ChunkView";

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
  const [context, setContext] = useState<ChunkRow[] | null>(null);
  const [loadingContext, setLoadingContext] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const handleToggleContext = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (expanded) {
      setExpanded(false);
      return;
    }
    if (context) {
      setExpanded(true);
      return;
    }
    if (!result.session_id || !result.chunk_id) return;
    setLoadingContext(true);
    try {
      const data = await getChunkContext(result.session_id, result.chunk_id, 2);
      setContext(data.chunks);
      setExpanded(true);
    } catch (err) {
      console.error("Failed to load context:", err);
    } finally {
      setLoadingContext(false);
    }
  };

  return (
    <div className="group">
      {/* Header row: session info */}
      <div
        onClick={() => result.session_id && navigate(`/sessions/${encodeURIComponent(result.session_id)}#chunk-${result.chunk_id}`)}
        className="cursor-pointer"
      >
        <div className="flex items-center justify-between gap-3 mb-1 px-1">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-xs font-mono text-gray-400">{index}</span>
            <h3 className="text-sm font-medium text-gray-800 truncate">
              {result.session_title || "(untitled)"}
            </h3>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {result.created_at && (
              <span className="text-xs text-gray-400">{formatDate(result.created_at)}</span>
            )}
            {typeof result.distance === "number" && (
              <span className="text-xs font-mono text-gray-400">
                {result.distance.toFixed(4)}
              </span>
            )}
            {result.source && <SourceBadge source={result.source} />}
          </div>
        </div>
      </div>

      {/* Context: before chunks */}
      {expanded && context && (() => {
        const idx = context.findIndex((c) => c.chunk_id === result.chunk_id);
        return context.slice(0, idx === -1 ? 0 : idx).map((c) => (
          <div key={c.chunk_id} className="opacity-50 mb-1">
            <ChunkView chunk={c} index={c.chunk_index} total={c.total_chunks} />
          </div>
        ));
      })()}

      {/* Main chunk */}
      <div
        onClick={() => result.session_id && navigate(`/sessions/${encodeURIComponent(result.session_id)}#chunk-${result.chunk_id}`)}
        className={`cursor-pointer hover:shadow-md transition-all ${expanded ? "ring-1 ring-violet-300/50 rounded-xl" : ""}`}
      >
        <ChunkView
          chunk={{
            chunk_id: result.chunk_id ?? "",
            chunk_index: result.chunk_index ?? 0,
            total_chunks: result.total_chunks ?? 1,
            section: result.section ?? "",
            heading_hierarchy: "",
            content: result.content ?? "",
            url: "",
          }}
          index={result.chunk_index ?? 0}
          total={result.total_chunks ?? 1}
        />
      </div>

      {/* Context: after chunks */}
      {expanded && context && (() => {
        const idx = context.findIndex((c) => c.chunk_id === result.chunk_id);
        return context.slice(idx === -1 ? context.length : idx + 1).map((c) => (
          <div key={c.chunk_id} className="opacity-50 mt-1">
            <ChunkView chunk={c} index={c.chunk_index} total={c.total_chunks} />
          </div>
        ));
      })()}

      {/* Context toggle button */}
      {result.session_id && result.chunk_id && (
        <button
          type="button"
          onClick={handleToggleContext}
          className="mt-1 px-3 py-1 text-xs text-gray-400 hover:text-gray-600 transition-colors cursor-pointer flex items-center gap-1"
        >
          {loadingContext ? (
            <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <svg className={`w-3 h-3 transition-transform ${expanded ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          )}
          {expanded ? "Hide context" : "Show context"}
        </button>
      )}
    </div>
  );
}
