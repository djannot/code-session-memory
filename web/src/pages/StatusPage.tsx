import StatusDashboard from "../components/StatusDashboard";
import { useStatus } from "../hooks/useStatus";

export default function StatusPage() {
  const { status, loading, error } = useStatus();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-100 mb-1">Status</h1>
        <p className="text-sm text-slate-500">
          Database statistics and tool installation status
        </p>
      </div>

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-12">
          <svg className="w-6 h-6 animate-spin text-slate-500" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      ) : status ? (
        <StatusDashboard status={status} />
      ) : null}
    </div>
  );
}
