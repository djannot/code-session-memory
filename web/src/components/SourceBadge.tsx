const sourceColors: Record<string, string> = {
  opencode: "bg-cyan-500/20 text-cyan-300 border-cyan-500/30",
  "claude-code": "bg-amber-500/20 text-amber-300 border-amber-500/30",
  cursor: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  vscode: "bg-blue-500/20 text-blue-300 border-blue-500/30",
  codex: "bg-violet-500/20 text-violet-300 border-violet-500/30",
  "gemini-cli": "bg-rose-500/20 text-rose-300 border-rose-500/30",
};

export default function SourceBadge({ source }: { source: string }) {
  const colors = sourceColors[source] || "bg-slate-500/20 text-slate-300 border-slate-500/30";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${colors}`}>
      {source}
    </span>
  );
}
