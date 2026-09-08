import { useState } from "react";
import { useAnalytics } from "../hooks/useAnalytics";
import type { ModelStat } from "../api/client";

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
  const { overview, tools, messages, models, loading, error, filters, setFilters } = useAnalytics();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-gray-900 mb-1">Analytics</h1>
        <p className="text-sm text-gray-500">
          Model comparison, tool usage, message breakdown, and session statistics
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

          {/* Model comparison */}
          <ModelComparison models={models} hasMessages={overview.total_messages > 0} />

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

// ---------------------------------------------------------------------------
// Model comparison
// ---------------------------------------------------------------------------

type Denominator = "turn" | "message";

function compact(n: number): string {
  if (!Number.isFinite(n)) return "\u2014";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  if (abs >= 100) return n.toFixed(0);
  if (abs >= 10) return n.toFixed(1);
  return n.toFixed(abs === 0 ? 0 : 2);
}

function ratio(num: number, den: number): number {
  return den > 0 ? num / den : 0;
}

/** Tokens the model actually read for a message: fresh input + cache reads + cache writes. */
function contextTokens(m: ModelStat): number {
  return m.input_tokens + m.cache_read_tokens + m.cache_write_tokens;
}

function ModelComparison({ models, hasMessages }: { models: ModelStat[]; hasMessages: boolean }) {
  const [per, setPer] = useState<Denominator>("turn");

  if (models.length === 0) {
    if (!hasMessages) return null;
    return (
      <div className="glass rounded-xl p-5 shadow-sm">
        <h3 className="text-sm font-medium text-gray-700 mb-2">Model Comparison</h3>
        <p className="text-sm text-gray-500">
          No per-model data yet. Model and token usage are recorded for Claude Code, OpenCode and Codex
          sessions as they are indexed. To fill in sessions indexed before this version, run{" "}
          <code className="font-mono text-xs bg-white/50 rounded px-1 py-0.5">
            npx code-session-memory backfill-analytics
          </code>
          .
        </p>
      </div>
    );
  }

  const den = (m: ModelStat) => (per === "turn" ? m.turn_count : m.message_count);
  // Token averages use only the messages that reported usage, so a source
  // without token data does not drag the average down.
  const tokenDen = (m: ModelStat) =>
    per === "turn"
      ? m.turn_count * ratio(m.messages_with_tokens, m.message_count)
      : m.messages_with_tokens;

  const hasCost = models.some((m) => m.cost !== null && m.cost > 0);
  const hasReasoning = models.some((m) => m.reasoning_tokens > 0);
  const totalTurns = models.reduce((acc, m) => acc + m.turn_count, 0);
  const palette = ["bg-violet-400", "bg-sky-400", "bg-emerald-400", "bg-amber-400", "bg-rose-400", "bg-teal-400", "bg-indigo-400", "bg-orange-400"];

  return (
    <div className="glass rounded-xl p-5 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="text-sm font-medium text-gray-700">Model Comparison</h3>
          <p className="text-xs text-gray-400 mt-0.5">
            A turn is one user prompt and everything the assistant did until it stopped. A message
            is one assistant response inside that turn — Claude Code and OpenCode produce one per
            model call (typically one per tool use), so a turn chains many; Codex records one per
            turn. Per-turn averages answer &ldquo;what does one prompt cost&rdquo;, per-message
            averages answer &ldquo;what does one model call cost&rdquo;. A turn that used several
            models counts once for each.
          </p>
        </div>
        <div className="flex items-center gap-1 text-xs" role="group" aria-label="Average per">
          <span className="text-gray-400 mr-1">Averages per</span>
          {(["turn", "message"] as Denominator[]).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setPer(d)}
              aria-pressed={per === d}
              className={`rounded-md px-2 py-1 transition-colors ${
                per === d ? "bg-violet-400 text-white shadow-sm" : "glass-subtle text-gray-600 hover:bg-white/60"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>

      {/* Share of turns */}
      {totalTurns > 0 && (
        <div className="mb-4">
          <div className="flex h-2.5 rounded-full overflow-hidden bg-white/40">
            {models.map((m, i) => (
              <div
                key={m.model}
                className={`${palette[i % palette.length]} h-full`}
                style={{ width: `${(m.turn_count / totalTurns) * 100}%` }}
                title={`${m.model}: ${m.turn_count.toLocaleString()} turns (${((m.turn_count / totalTurns) * 100).toFixed(1)}%)`}
              />
            ))}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
            {models.map((m, i) => (
              <span key={m.model} className="flex items-center gap-1.5 text-xs text-gray-500">
                <span className={`w-2 h-2 rounded-full ${palette[i % palette.length]}`} />
                <span className="font-mono">{m.model}</span>
                <span className="text-gray-400">{((m.turn_count / totalTurns) * 100).toFixed(0)}%</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-gray-500 text-right">
              <th className="text-left font-medium pb-2 pr-3">Model</th>
              <th className="font-medium pb-2 px-2">Sessions</th>
              <th className="font-medium pb-2 px-2">Turns</th>
              <th className="font-medium pb-2 px-2">Messages</th>
              <th className="font-medium pb-2 px-2" title="Assistant messages (model calls) per turn">Msgs /turn</th>
              <th className="font-medium pb-2 px-2" title={`Tool calls per ${per}`}>Tool calls /{per}</th>
              <th className="font-medium pb-2 px-2" title={`Output tokens per ${per} (including reasoning)`}>Output tok /{per}</th>
              <th className="font-medium pb-2 px-2" title={`Context read per ${per}: input + cache read + cache write`}>Context tok /{per}</th>
              <th className="font-medium pb-2 px-2" title="Share of context tokens served from the prompt cache">Cache hit</th>
              {hasReasoning && (
                <th className="font-medium pb-2 px-2" title={`Reasoning (thinking) tokens per ${per}`}>Reasoning /{per}</th>
              )}
              {hasCost && <th className="font-medium pb-2 pl-2" title="Total cost reported by the source">Cost</th>}
            </tr>
          </thead>
          <tbody>
            {models.map((m, i) => {
              const d = den(m);
              const td = tokenDen(m);
              const ctx = contextTokens(m);
              const cacheHit = ctx > 0 ? (m.cache_read_tokens / ctx) * 100 : null;
              const noTokens = m.messages_with_tokens === 0;
              return (
                <tr key={m.model} className="border-t border-white/40 text-right text-gray-700">
                  <td className="text-left py-2 pr-3">
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${palette[i % palette.length]}`} />
                      <div className="min-w-0">
                        <div className="font-mono text-gray-900 truncate" title={m.model}>{m.model}</div>
                        <div className="text-xs text-gray-400 truncate">
                          {m.sources.split(",").filter(Boolean).join(", ")}
                          {m.provider ? ` · ${m.provider}` : ""}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="py-2 px-2 font-mono">{m.session_count.toLocaleString()}</td>
                  <td className="py-2 px-2 font-mono">{m.turn_count.toLocaleString()}</td>
                  <td className="py-2 px-2 font-mono">{m.message_count.toLocaleString()}</td>
                  <td className="py-2 px-2 font-mono">{compact(ratio(m.message_count, m.turn_count))}</td>
                  <td className="py-2 px-2 font-mono">{compact(ratio(m.tool_call_count, d))}</td>
                  <td className="py-2 px-2 font-mono" title={`${m.output_tokens.toLocaleString()} total`}>
                    {noTokens ? "\u2014" : compact(ratio(m.output_tokens, td))}
                  </td>
                  <td className="py-2 px-2 font-mono" title={`${ctx.toLocaleString()} total`}>
                    {noTokens ? "\u2014" : compact(ratio(ctx, td))}
                  </td>
                  <td className="py-2 px-2 font-mono">
                    {cacheHit === null ? "\u2014" : `${cacheHit.toFixed(0)}%`}
                  </td>
                  {hasReasoning && (
                    <td className="py-2 px-2 font-mono" title={`${m.reasoning_tokens.toLocaleString()} total`}>
                      {noTokens ? "\u2014" : compact(ratio(m.reasoning_tokens, td))}
                    </td>
                  )}
                  {hasCost && (
                    <td className="py-2 pl-2 font-mono">
                      {m.cost === null ? "\u2014" : `$${m.cost.toFixed(2)}`}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
