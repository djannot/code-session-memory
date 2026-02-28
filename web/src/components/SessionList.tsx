import { useNavigate } from "react-router-dom";
import type { SessionRow } from "../api/client";
import SourceBadge from "./SourceBadge";

function formatDate(unixMs: number): string {
  if (!unixMs) return "\u2014";
  return new Date(unixMs).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatProject(project: string): string {
  if (!project) return "\u2014";
  const parts = project.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 3 ? ".../" + parts.slice(-3).join("/") : project;
}

interface SessionListProps {
  sessions: SessionRow[];
  onDelete?: (id: string) => void;
}

export default function SessionList({ sessions, onDelete }: SessionListProps) {
  const navigate = useNavigate();

  if (sessions.length === 0) {
    return (
      <div className="text-center py-12 text-gray-400">
        No sessions found.
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl glass shadow-sm">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-white/20">
            <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Title</th>
            <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Source</th>
            <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider hidden md:table-cell">Project</th>
            <th className="text-left px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider hidden sm:table-cell">Date</th>
            <th className="text-right px-4 py-3 text-xs font-medium text-gray-500 uppercase tracking-wider">Chunks</th>
            {onDelete && <th className="w-10" />}
          </tr>
        </thead>
        <tbody className="divide-y divide-white/15">
          {sessions.map((s) => (
            <tr
              key={s.session_id}
              onClick={() => navigate(`/sessions/${encodeURIComponent(s.session_id)}`)}
              className="hover:bg-white/30 cursor-pointer transition-colors"
            >
              <td className="px-4 py-3 text-gray-800 truncate max-w-xs">
                {s.session_title || <span className="text-gray-400">(untitled)</span>}
              </td>
              <td className="px-4 py-3">
                <SourceBadge source={s.source} />
              </td>
              <td className="px-4 py-3 text-gray-500 text-xs font-mono truncate max-w-xs hidden md:table-cell">
                {formatProject(s.project)}
              </td>
              <td className="px-4 py-3 text-gray-500 text-xs hidden sm:table-cell whitespace-nowrap">
                {formatDate(s.updated_at)}
              </td>
              <td className="px-4 py-3 text-right text-gray-500 font-mono text-xs">
                {s.chunk_count}
              </td>
              {onDelete && (
                <td className="px-2 py-3">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(s.session_id);
                    }}
                    className="p-1 text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
                    title="Delete session"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
