import { useNavigate } from "react-router-dom";
import type { QueryResult } from "../api/client";
import SourceBadge from "./SourceBadge";
import MarkdownContent from "./MarkdownContent";

function formatDate(unixMs?: number): string {
  if (!unixMs) return "";
  return new Date(unixMs).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Detects known roles from the section heading and returns a tint */
function getRoleTint(section?: string): string {
  const lower = (section || "").toLowerCase();
  if (lower.startsWith("user") || lower === "human") return "bg-blue-200/20";
  if (lower.startsWith("assistant")) return "bg-emerald-200/20";
  if (lower.startsWith("tool")) return "bg-amber-200/20";
  return "";
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
  const roleTint = getRoleTint(result.section);

  return (
    <div
      onClick={() => result.session_id && navigate(`/sessions/${encodeURIComponent(result.session_id)}`)}
      className="group glass rounded-xl p-4 hover:shadow-md hover:bg-white/65 transition-all cursor-pointer shadow-sm"
    >
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono text-gray-400">{index}</span>
          <h3 className="text-sm font-medium text-gray-800 truncate">
            {result.session_title || "(untitled)"}
          </h3>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {typeof result.distance === "number" && (
            <span className="text-xs font-mono text-gray-400">
              {result.distance.toFixed(4)}
            </span>
          )}
          {result.source && <SourceBadge source={result.source} />}
        </div>
      </div>

      <div className={`glass-subtle rounded-lg p-3 max-h-96 overflow-hidden ${roleTint}`}>
        <MarkdownContent
          content={truncated}
          className="text-xs text-gray-600"
        />
      </div>

      <div className="flex items-center gap-3 mt-2 text-xs text-gray-400">
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
