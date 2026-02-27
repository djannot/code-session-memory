import type { ChunkRow } from "../api/client";

interface ChunkViewProps {
  chunk: ChunkRow;
  index: number;
  total: number;
}

export default function ChunkView({ chunk, index, total }: ChunkViewProps) {
  return (
    <div className="bg-slate-900/30 border border-slate-800/50 rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2 bg-slate-900/50 border-b border-slate-800/50">
        <div className="flex items-center gap-3">
          <span className="text-xs font-mono text-slate-600">
            {index + 1}/{total}
          </span>
          {chunk.section && (
            <span className="text-xs text-slate-400">{chunk.section}</span>
          )}
        </div>
      </div>
      <pre className="p-4 text-xs text-slate-300 whitespace-pre-wrap break-words font-mono leading-relaxed overflow-x-auto">
        {chunk.content}
      </pre>
    </div>
  );
}
