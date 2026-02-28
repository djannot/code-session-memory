import { useNavigate } from "react-router-dom";
import type { QueryResult } from "../api/client";
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

  return (
    <div
      onClick={() => result.session_id && navigate(`/sessions/${encodeURIComponent(result.session_id)}`)}
      className="group hover:shadow-md transition-all cursor-pointer"
    >
      {/* Header row: session info */}
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

      {/* Chunk content using ChunkView */}
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
  );
}
