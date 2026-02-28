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
    <div className="space-y-2">
      {/* Header row: session info, source, distance */}
      <div
        onClick={() => result.session_id && navigate(`/sessions/${encodeURIComponent(result.session_id)}`)}
        className="flex items-center gap-3 cursor-pointer hover:opacity-80 transition-opacity"
      >
        <span className="text-xs font-mono text-gray-400">{index}</span>
        <h3 className="text-sm font-medium text-gray-800 truncate">
          {result.session_title || "(untitled)"}
        </h3>
        <div className="flex items-center gap-2 ml-auto shrink-0">
          {typeof result.distance === "number" && (
            <span className="text-xs font-mono text-gray-400">
              {result.distance.toFixed(4)}
            </span>
          )}
          {result.source && <SourceBadge source={result.source} />}
          {result.created_at && (
            <span className="text-xs text-gray-400">{formatDate(result.created_at)}</span>
          )}
        </div>
      </div>

      {/* Chunk content using ChunkView (same as sessions page) */}
      <div
        onClick={() => result.session_id && navigate(`/sessions/${encodeURIComponent(result.session_id)}`)}
        className="cursor-pointer hover:shadow-md transition-shadow rounded-xl"
      >
        <ChunkView
          chunk={{
            chunk_id: result.chunk_id,
            chunk_index: result.chunk_index ?? 0,
            total_chunks: result.total_chunks ?? 1,
            section: result.section || "",
            heading_hierarchy: result.heading_hierarchy || "",
            content: result.content ?? "",
            url: result.url || "",
          }}
          index={result.chunk_index ?? 0}
          total={result.total_chunks ?? 1}
        />
      </div>
    </div>
  );
}
