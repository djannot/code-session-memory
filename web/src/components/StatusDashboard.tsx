import type { StatusResult } from "../api/client";
import SourceBadge from "./SourceBadge";

function formatBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

const toolDisplayNames: Record<string, string> = {
  opencode: "OpenCode",
  "claude-code": "Claude Code",
  cursor: "Cursor",
  vscode: "VS Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
};

export default function StatusDashboard({ status }: { status: StatusResult }) {
  return (
    <div className="space-y-6">
      {/* DB Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Sessions" value={status.totalSessions.toLocaleString()} />
        <StatCard label="Chunks" value={status.totalChunks.toLocaleString()} />
        <StatCard label="DB Size" value={formatBytes(status.dbSizeBytes)} />
        <StatCard
          label="Status"
          value={status.allOk ? "OK" : "Issues"}
          valueClass={status.allOk ? "text-emerald-600" : "text-amber-600"}
        />
      </div>

      {/* Sessions by source */}
      {status.sessionsBySource.length > 0 && (
        <div className="glass rounded-xl p-5 shadow-sm">
          <h3 className="text-sm font-medium text-gray-700 mb-4">Sessions by Source</h3>
          <div className="space-y-3">
            {status.sessionsBySource.map((s) => {
              const pct = status.totalSessions > 0
                ? (s.count / status.totalSessions) * 100
                : 0;
              return (
                <div key={s.source} className="flex items-center gap-3">
                  <div className="w-24">
                    <SourceBadge source={s.source} />
                  </div>
                  <div className="flex-1 h-2 bg-white/40 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-violet-400 rounded-full transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-xs font-mono text-gray-500 w-12 text-right">
                    {s.count}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Tool installation status */}
      <div className="glass rounded-xl p-5 shadow-sm">
        <h3 className="text-sm font-medium text-gray-700 mb-4">Tool Installation</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {Object.entries(status.tools).map(([key, tool]) => (
            <div
              key={key}
              className={`rounded-lg p-3 ${
                !tool.installed
                  ? "bg-white/20"
                  : "glass-subtle"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-800">
                  {toolDisplayNames[key] || key}
                </span>
                {!tool.installed ? (
                  <span className="text-xs text-gray-400">Not installed</span>
                ) : tool.components.every((c) => c.ok) ? (
                  <span className="text-xs text-emerald-600">All OK</span>
                ) : (
                  <span className="text-xs text-amber-600">Issues</span>
                )}
              </div>
              {tool.installed && (
                <div className="space-y-1">
                  {tool.components.map((c) => (
                    <div key={c.name} className="flex items-center gap-2 text-xs">
                      <span className={c.ok ? "text-emerald-500" : "text-red-500"}>
                        {c.ok ? "\u2713" : "\u2717"}
                      </span>
                      <span className="text-gray-600">{c.name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* DB path */}
      <div className="text-xs text-gray-400 font-mono">
        DB: {status.dbPath}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  valueClass = "text-gray-900",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="glass rounded-xl p-4 shadow-sm">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`text-xl font-semibold ${valueClass}`}>{value}</div>
    </div>
  );
}
