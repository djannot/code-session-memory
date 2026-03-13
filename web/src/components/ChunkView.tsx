import { useEffect, useRef, useState } from "react";
import type { ChunkRow } from "../api/client";
import MarkdownContent from "./MarkdownContent";

/** Detects known roles from the section heading and returns style + label */
function getRoleStyle(section: string): { bg: string; label: string; labelBg: string; roleName: string } | null {
  const lower = section.toLowerCase();
  if (lower.startsWith("user") || lower === "human") {
    return {
      bg: "bg-blue-200/25",
      label: "text-blue-700",
      labelBg: "bg-blue-200/40",
      roleName: "User",
    };
  }
  if (lower.startsWith("assistant")) {
    return {
      bg: "bg-emerald-200/25",
      label: "text-emerald-700",
      labelBg: "bg-emerald-200/40",
      roleName: section,
    };
  }
  if (lower === "tool result" || lower === "tool") {
    return {
      bg: "bg-amber-200/25",
      label: "text-amber-700",
      labelBg: "bg-amber-200/40",
      roleName: "Tool Result",
    };
  }
  if (lower.startsWith("tool:")) {
    return {
      bg: "bg-purple-200/25",
      label: "text-purple-700",
      labelBg: "bg-purple-200/40",
      roleName: section,
    };
  }
  return null;
}

interface ChunkViewProps {
  chunk: ChunkRow;
  index: number;
  total: number;
  highlighted?: boolean;
}

export default function ChunkView({ chunk, index, total, highlighted }: ChunkViewProps) {
  const role = getRoleStyle(chunk.section);
  const bgTint = role?.bg ?? "";
  const ref = useRef<HTMLDivElement>(null);
  const [pulse, setPulse] = useState(highlighted ?? false);

  useEffect(() => {
    if (highlighted) {
      setPulse(true);
      const timer = setTimeout(() => setPulse(false), 2000);
      return () => clearTimeout(timer);
    }
  }, [highlighted]);

  return (
    <div
      id={`chunk-${chunk.chunk_id}`}
      ref={ref}
      className={`glass rounded-xl overflow-hidden shadow-sm ${bgTint} ${
        pulse ? "ring-2 ring-violet-400 animate-pulse" : ""
      } transition-all`}
    >
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/20">
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-gray-400">
            {index + 1}/{total}
          </span>
          {role && (
            <span className={`text-xs font-medium px-2 py-0.5 rounded-md backdrop-blur-sm ${role.labelBg} ${role.label}`}>
              {role.roleName}
            </span>
          )}
        </div>
      </div>
      <MarkdownContent
        content={chunk.content}
        className="p-4 text-sm text-gray-700 leading-relaxed overflow-x-auto"
      />
    </div>
  );
}
