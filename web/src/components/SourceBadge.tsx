const sourceColors: Record<string, string> = {
  opencode: "bg-cyan-200/40 text-cyan-800 border-cyan-300/40",
  "claude-code": "bg-amber-200/40 text-amber-800 border-amber-300/40",
  cursor: "bg-emerald-200/40 text-emerald-800 border-emerald-300/40",
  vscode: "bg-blue-200/40 text-blue-800 border-blue-300/40",
  codex: "bg-violet-200/40 text-violet-800 border-violet-300/40",
  "gemini-cli": "bg-rose-200/40 text-rose-800 border-rose-300/40",
};

export default function SourceBadge({ source }: { source: string }) {
  const colors = sourceColors[source] || "bg-gray-200/40 text-gray-700 border-gray-300/40";
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border backdrop-blur-sm ${colors}`}>
      {source}
    </span>
  );
}
