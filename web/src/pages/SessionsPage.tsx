import { useState, useMemo } from "react";
import SessionList from "../components/SessionList";
import ConfirmDialog from "../components/ConfirmDialog";
import { useSessions } from "../hooks/useSessions";
import type { ReindexCheckResult } from "../api/client";

const SOURCES = ["", "opencode", "claude-code", "cursor", "vscode", "codex", "gemini-cli"];

export default function SessionsPage() {
  const { sessions, loading, error, filters, setFilters, deleteSession, bulkDelete, purgeSessions, checkReindex, bulkReindex } = useSessions();
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeDays, setPurgeDays] = useState(30);
  const [purgeResult, setPurgeResult] = useState<string | null>(null);

  // Search & selection state
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkDeleteResult, setBulkDeleteResult] = useState<string | null>(null);

  // Reindex state
  const [reindexCheckResult, setReindexCheckResult] = useState<ReindexCheckResult | null>(null);
  const [reindexChecking, setReindexChecking] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const [reindexResult, setReindexResult] = useState<string | null>(null);

  // Filter sessions by search text (title or project)
  const filteredSessions = useMemo(() => {
    if (!search.trim()) return sessions;
    const q = search.toLowerCase();
    return sessions.filter(
      (s) =>
        (s.session_title && s.session_title.toLowerCase().includes(q)) ||
        (s.project && s.project.toLowerCase().includes(q)),
    );
  }, [sessions, search]);

  // Clear selection when filters or search change
  const handleSearchChange = (value: string) => {
    setSearch(value);
    setSelected(new Set());
  };

  const handleToggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleToggleAll = () => {
    const visibleIds = filteredSessions.map((s) => s.session_id);
    const allSelected = visibleIds.every((id) => selected.has(id));
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(visibleIds));
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteSession(deleteTarget);
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(deleteTarget);
        return next;
      });
    } catch {
      // ignore
    }
    setDeleteTarget(null);
  };

  const handleBulkDelete = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setBulkDeleting(true);
    try {
      const deleted = await bulkDelete(ids);
      setBulkDeleteResult(`Deleted ${ids.length} session${ids.length !== 1 ? "s" : ""} (${deleted} chunks)`);
      setSelected(new Set());
    } catch {
      // ignore
    } finally {
      setBulkDeleting(false);
      setBulkDeleteOpen(false);
    }
  };

  const handleReindexCheck = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    setReindexChecking(true);
    try {
      const result = await checkReindex(ids);
      setReindexCheckResult(result);
    } catch {
      // ignore
    } finally {
      setReindexChecking(false);
    }
  };

  const handleReindexConfirm = async () => {
    if (!reindexCheckResult) return;
    const ids = reindexCheckResult.ready.map((s) => s.id);
    if (ids.length === 0) return;
    setReindexing(true);
    try {
      const result = await bulkReindex(ids);
      const parts: string[] = [`Reindexed ${result.reindexed} session${result.reindexed !== 1 ? "s" : ""}`];
      if (result.failed.length > 0) {
        parts.push(`${result.failed.length} failed`);
      }
      setReindexResult(parts.join(", "));
      setSelected(new Set());
    } catch {
      // ignore
    } finally {
      setReindexing(false);
      setReindexCheckResult(null);
    }
  };

  const handlePurge = async () => {
    try {
      const result = await purgeSessions(purgeDays);
      setPurgeResult(`Deleted ${result.sessions} sessions (${result.chunks} chunks)`);
      setSelected(new Set());
    } catch {
      // ignore
    }
    setPurgeOpen(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 mb-1">Sessions</h1>
          <p className="text-sm text-gray-500">
            {filteredSessions.length === sessions.length
              ? `${sessions.length} session${sessions.length !== 1 ? "s" : ""} indexed`
              : `${filteredSessions.length} of ${sessions.length} sessions`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selected.size > 0 && (
            <>
              <button
                onClick={handleReindexCheck}
                disabled={reindexChecking}
                className="px-3 py-1.5 text-xs rounded-lg bg-violet-600 text-white hover:bg-violet-500 transition-colors cursor-pointer shadow-md shadow-violet-600/25 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {reindexChecking && (
                  <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
                Reindex selected ({selected.size})
              </button>
              <button
                onClick={() => setBulkDeleteOpen(true)}
                className="px-3 py-1.5 text-xs rounded-lg bg-red-600 text-white hover:bg-red-500 transition-colors cursor-pointer shadow-md shadow-red-600/25"
              >
                Delete selected ({selected.size})
              </button>
            </>
          )}
          <button
            onClick={() => setPurgeOpen(true)}
            className="px-3 py-1.5 text-xs rounded-lg glass text-gray-500 hover:text-gray-700 hover:bg-white/70 transition-all cursor-pointer shadow-sm"
          >
            Purge old...
          </button>
        </div>
      </div>

      {/* Search + Filters */}
      <div className="flex flex-wrap gap-3">
        <input
          type="text"
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          placeholder="Search by title or project..."
          className="flex-1 min-w-[200px] px-3 py-1.5 glass rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-violet-400/50 shadow-sm"
        />
        <select
          value={filters.source || ""}
          onChange={(e) => { setFilters({ ...filters, source: e.target.value || undefined }); setSelected(new Set()); }}
          className="px-3 py-1.5 glass rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-violet-400/50 shadow-sm"
        >
          <option value="">All sources</option>
          {SOURCES.filter(Boolean).map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input
          type="date"
          value={filters.from || ""}
          onChange={(e) => { setFilters({ ...filters, from: e.target.value || undefined }); setSelected(new Set()); }}
          className="px-3 py-1.5 glass rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-violet-400/50 shadow-sm"
          placeholder="From"
        />
        <input
          type="date"
          value={filters.to || ""}
          onChange={(e) => { setFilters({ ...filters, to: e.target.value || undefined }); setSelected(new Set()); }}
          className="px-3 py-1.5 glass rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-violet-400/50 shadow-sm"
          placeholder="To"
        />
      </div>

      {error && (
        <div className="glass rounded-xl p-4 text-sm text-red-700 bg-red-100/30 shadow-sm">
          {error}
        </div>
      )}

      {purgeResult && (
        <div className="glass rounded-xl p-4 text-sm text-emerald-700 bg-emerald-100/30 shadow-sm flex items-center justify-between">
          {purgeResult}
          <button onClick={() => setPurgeResult(null)} className="text-emerald-500 hover:text-emerald-700 cursor-pointer">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {bulkDeleteResult && (
        <div className="glass rounded-xl p-4 text-sm text-emerald-700 bg-emerald-100/30 shadow-sm flex items-center justify-between">
          {bulkDeleteResult}
          <button onClick={() => setBulkDeleteResult(null)} className="text-emerald-500 hover:text-emerald-700 cursor-pointer">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {reindexResult && (
        <div className="glass rounded-xl p-4 text-sm text-violet-700 bg-violet-100/30 shadow-sm flex items-center justify-between">
          {reindexResult}
          <button onClick={() => setReindexResult(null)} className="text-violet-500 hover:text-violet-700 cursor-pointer">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <svg className="w-6 h-6 animate-spin text-violet-400" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      ) : (
        <SessionList
          sessions={filteredSessions}
          onDelete={(id) => setDeleteTarget(id)}
          selected={selected}
          onToggle={handleToggle}
          onToggleAll={handleToggleAll}
        />
      )}

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete session"
        message="This will permanently remove this session and all its chunks from the database. If source files still exist, it will be re-indexed on the next agent turn."
        confirmLabel="Delete"
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Bulk delete confirmation */}
      <ConfirmDialog
        open={bulkDeleteOpen}
        title="Delete selected sessions"
        message={`This will permanently delete ${selected.size} selected session${selected.size !== 1 ? "s" : ""} and all their chunks. This cannot be undone.`}
        confirmLabel={`Delete ${selected.size}`}
        loading={bulkDeleting}
        onConfirm={handleBulkDelete}
        onCancel={() => setBulkDeleteOpen(false)}
      />

      {/* Reindex confirmation dialog */}
      {reindexCheckResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-md">
          <div className="glass-strong rounded-2xl shadow-2xl p-6 max-w-lg w-full mx-4 max-h-[80vh] flex flex-col">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Reindex sessions</h3>

            {reindexCheckResult.ready.length > 0 && (
              <div className="mb-4">
                <p className="text-sm font-medium text-emerald-700 mb-2">
                  {reindexCheckResult.ready.length} session{reindexCheckResult.ready.length !== 1 ? "s" : ""} will be reindexed
                </p>
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {reindexCheckResult.ready.map((s) => (
                    <div key={s.id} className="text-xs text-gray-600 flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" />
                      <span className="truncate">{s.title}</span>
                      <span className="text-gray-400 shrink-0">({s.source})</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {reindexCheckResult.skipped.length > 0 && (
              <div className="mb-4">
                <p className="text-sm font-medium text-gray-500 mb-2">
                  {reindexCheckResult.skipped.length} session{reindexCheckResult.skipped.length !== 1 ? "s" : ""} cannot be reindexed
                </p>
                <div className="max-h-32 overflow-y-auto space-y-1">
                  {reindexCheckResult.skipped.map((s) => (
                    <div key={s.id} className="text-xs text-gray-400 flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-300 shrink-0" />
                      <span className="truncate">{s.title}</span>
                      <span className="shrink-0">({s.source})</span>
                      <span className="italic shrink-0">{s.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {reindexCheckResult.ready.length === 0 && (
              <p className="text-sm text-gray-500 mb-4">None of the selected sessions can be reindexed.</p>
            )}

            <div className="flex justify-end gap-3 mt-auto pt-4">
              <button
                onClick={() => setReindexCheckResult(null)}
                disabled={reindexing}
                className="px-4 py-2 text-sm rounded-lg glass text-gray-700 hover:bg-white/70 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              {reindexCheckResult.ready.length > 0 && (
                <button
                  onClick={handleReindexConfirm}
                  disabled={reindexing}
                  className="px-4 py-2 text-sm rounded-lg bg-violet-600 text-white hover:bg-violet-500 transition-colors cursor-pointer shadow-md shadow-violet-600/25 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {reindexing && (
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  {reindexing ? "Reindexing..." : `Reindex ${reindexCheckResult.ready.length}`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Purge dialog */}
      {purgeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-md">
          <div className="glass-strong rounded-2xl shadow-2xl p-6 max-w-md w-full mx-4">
            <h3 className="text-lg font-semibold text-gray-900 mb-4">Purge old sessions</h3>
            <label className="block text-sm text-gray-600 mb-2">
              Delete sessions older than:
            </label>
            <div className="flex items-center gap-2 mb-6">
              <input
                type="number"
                min={1}
                value={purgeDays}
                onChange={(e) => setPurgeDays(Number(e.target.value))}
                className="w-24 px-3 py-2 glass rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-violet-400/50"
              />
              <span className="text-sm text-gray-600">days</span>
            </div>
            <div className="flex justify-end gap-3">
              <button
                onClick={() => setPurgeOpen(false)}
                className="px-4 py-2 text-sm rounded-lg glass text-gray-700 hover:bg-white/70 transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={handlePurge}
                className="px-4 py-2 text-sm rounded-lg bg-red-600 text-white hover:bg-red-500 transition-colors cursor-pointer shadow-md shadow-red-600/25"
              >
                Purge
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
