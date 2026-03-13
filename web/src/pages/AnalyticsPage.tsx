import { useAnalytics } from "../hooks/useAnalytics";

const SOURCES = ["opencode", "claude-code", "cursor", "vscode", "codex", "gemini-cli"];

const roleColors: Record<string, string> = {
  user: "bg-blue-400",
  assistant: "bg-emerald-400",
  tool: "bg-amber-400",
};

function formatDate(unixMs: number | null): string {
  if (!unixMs) return "\u2014";
  return new Date(unixMs).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function AnalyticsPage() {
  const { overview, tools, messages, loading, error, filters, setFilters } = useAnalytics();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-gray-900 mb-1">Analytics</h1>
        <p className="text-sm text-gray-500">
          Tool usage, message breakdown, and session statistics
        </p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Source</label>
          <select
            value={filters.source || ""}
            onChange={(e) => setFilters({ ...filters, source: e.target.value || undefined })}
            className="glass rounded-lg px-3 py-1.5 text-sm text-gray-700 shadow-sm"
          >
            <option value="">All sources</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">From</label>
          <input
            type="date"
            value={filters.from || ""}
            onChange={(e) => setFilters({ ...filters, from: e.target.value || undefined })}
            className="glass rounded-lg px-3 py-1.5 text-sm text-gray-700 shadow-sm"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">To</label>
          <input
            type="date"
            value={filters.to || ""}
            onChange={(e) => setFilters({ ...filters, to: e.target.value || undefined })}
            className="glass rounded-lg px-3 py-1.5 text-sm text-gray-700 shadow-sm"
          />
        </div>
      </div>

      {error && (
        <div className="glass rounded-xl p-4 text-sm text-red-700 bg-red-100/30 shadow-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <svg className="w-6 h-6 animate-spin text-violet-400" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      ) : overview ? (
        <div className="space-y-6">
          {/* Overview cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard label="Messages" value={overview.total_messages.toLocaleString()} />
            <StatCard label="Tool Calls" value={overview.total_tool_calls.toLocaleString()} />
            <StatCard label="Sessions" value={overview.total_sessions.toLocaleString()} />
            <StatCard
              label="Date Range"
              value={
                overview.earliest_message_at
                  ? `${formatDate(overview.earliest_message_at)} \u2013 ${formatDate(overview.latest_message_at)}`
                  : "\u2014"
              }
              small
            />
          </div>

          {/* Messages by Role */}
          {messages.length > 0 && (
            <div className="glass rounded-xl p-5 shadow-sm">
              <h3 className="text-sm font-medium text-gray-700 mb-4">Messages by Role</h3>
              <div className="flex gap-4">
                {messages.map((m) => {
                  const total = messages.reduce((acc, x) => acc + x.count, 0);
                  const pct = total > 0 ? ((m.count / total) * 100).toFixed(1) : "0";
                  return (
                    <div key={m.role} className="flex-1 glass-subtle rounded-lg p-3">
                      <div className="flex items-center gap-2 mb-1">
                        <div className={`w-2 h-2 rounded-full ${roleColors[m.role] || "bg-gray-400"}`} />
                        <span className="text-xs text-gray-500 capitalize">{m.role}</span>
                      </div>
                      <div className="text-lg font-semibold text-gray-900">{m.count.toLocaleString()}</div>
                      <div className="text-xs text-gray-400">{pct}%</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Tool Usage */}
          {tools.length > 0 && (
            <div className="glass rounded-xl p-5 shadow-sm">
              <h3 className="text-sm font-medium text-gray-700 mb-4">Tool Usage</h3>
              <div className="space-y-2">
                {tools.map((t) => {
                  const maxCalls = tools[0]?.call_count || 1;
                  const pct = (t.call_count / maxCalls) * 100;
                  const errorRate = t.call_count > 0
                    ? ((t.error_count / t.call_count) * 100).toFixed(1)
                    : "0";
                  return (
                    <div key={t.tool_name} className="flex items-center gap-3">
                      <span className="text-sm text-gray-700 w-32 truncate font-mono" title={t.tool_name}>
                        {t.tool_name}
                      </span>
                      <div className="flex-1 h-3 bg-white/40 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-violet-400 rounded-full transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-xs font-mono text-gray-600 w-14 text-right">
                        {t.call_count.toLocaleString()}
                      </span>
                      <span
                        className={`text-xs font-mono w-14 text-right ${
                          t.error_count > 0 ? "text-red-500" : "text-gray-400"
                        }`}
                        title={`${t.error_count} errors`}
                      >
                        {errorRate}% err
                      </span>
                      <span className="text-xs text-gray-400 w-14 text-right" title="Sessions using this tool">
                        {t.session_count} sess
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {overview.total_messages === 0 && (
            <div className="text-center py-12 text-gray-400 text-sm">
              No analytics data yet. Data is collected as new sessions are indexed.
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function StatCard({
  label,
  value,
  small,
}: {
  label: string;
  value: string;
  small?: boolean;
}) {
  return (
    <div className="glass rounded-xl p-4 shadow-sm">
      <div className="text-xs text-gray-500 mb-1">{label}</div>
      <div className={`font-semibold text-gray-900 ${small ? "text-sm" : "text-xl"}`}>{value}</div>
    </div>
  );
}
