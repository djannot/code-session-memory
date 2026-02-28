import { useState } from "react";
import SessionList from "../components/SessionList";
import ConfirmDialog from "../components/ConfirmDialog";
import { useSessions } from "../hooks/useSessions";

const SOURCES = ["", "opencode", "claude-code", "cursor", "vscode", "codex", "gemini-cli"];

export default function SessionsPage() {
  const { sessions, loading, error, filters, setFilters, deleteSession, purgeSessions } = useSessions();
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeDays, setPurgeDays] = useState(30);
  const [purgeResult, setPurgeResult] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteSession(deleteTarget);
    } catch {
      // ignore
    }
    setDeleteTarget(null);
  };

  const handlePurge = async () => {
    try {
      const result = await purgeSessions(purgeDays);
      setPurgeResult(`Deleted ${result.sessions} sessions (${result.chunks} chunks)`);
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
            {sessions.length} session{sessions.length !== 1 ? "s" : ""} indexed
          </p>
        </div>
        <button
          onClick={() => setPurgeOpen(true)}
          className="px-3 py-1.5 text-xs rounded-lg glass text-gray-500 hover:text-gray-700 hover:bg-white/70 transition-all cursor-pointer shadow-sm"
        >
          Purge old...
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          value={filters.source || ""}
          onChange={(e) => setFilters({ ...filters, source: e.target.value || undefined })}
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
          onChange={(e) => setFilters({ ...filters, from: e.target.value || undefined })}
          className="px-3 py-1.5 glass rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-violet-400/50 shadow-sm"
          placeholder="From"
        />
        <input
          type="date"
          value={filters.to || ""}
          onChange={(e) => setFilters({ ...filters, to: e.target.value || undefined })}
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

      {loading ? (
        <div className="flex justify-center py-12">
          <svg className="w-6 h-6 animate-spin text-violet-400" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      ) : (
        <SessionList sessions={sessions} onDelete={(id) => setDeleteTarget(id)} />
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
