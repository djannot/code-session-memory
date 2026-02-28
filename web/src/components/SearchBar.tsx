import { useState } from "react";

const SOURCES = ["", "opencode", "claude-code", "cursor", "vscode", "codex", "gemini-cli"];
const SECTION_OPTIONS = [
  { value: "", label: "All types" },
  { value: "user", label: "User" },
  { value: "assistant", label: "Assistant" },
  { value: "tool", label: "Tool" },
];

interface SearchBarProps {
  onSearch: (params: {
    queryText: string;
    source?: string;
    limit?: number;
    fromDate?: string;
    toDate?: string;
    sectionFilter?: string;
    hybrid?: boolean;
  }) => void;
  loading: boolean;
}

export default function SearchBar({ onSearch, loading }: SearchBarProps) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [sectionFilter, setSectionFilter] = useState("");
  const [hybrid, setHybrid] = useState(false);
  const [limit, setLimit] = useState(10);
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    onSearch({
      queryText: query.trim(),
      source: source || undefined,
      limit,
      fromDate: fromDate || undefined,
      toDate: toDate || undefined,
      sectionFilter: sectionFilter || undefined,
      hybrid: hybrid || undefined,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search across all sessions..."
            className="w-full pl-10 pr-4 py-2.5 glass rounded-xl text-sm text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-violet-400/50 shadow-sm transition-all"
          />
        </div>
        <button
          type="button"
          onClick={() => setShowFilters(!showFilters)}
          className={`px-3 py-2.5 rounded-xl text-sm transition-all cursor-pointer shadow-sm ${
            showFilters
              ? "glass-strong text-gray-700"
              : "glass text-gray-500 hover:text-gray-700"
          }`}
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
          </svg>
        </button>
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="px-5 py-2.5 bg-violet-600 text-white text-sm font-medium rounded-xl hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all cursor-pointer shadow-md shadow-violet-600/25"
        >
          {loading ? (
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            "Search"
          )}
        </button>
      </div>

      {showFilters && (
        <div className="flex flex-wrap gap-3 p-3 glass rounded-xl shadow-sm">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">Type</label>
            <div className="flex rounded-lg overflow-hidden border border-white/30">
              {SECTION_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setSectionFilter(opt.value)}
                  className={`px-3 py-1.5 text-xs font-medium transition-all cursor-pointer ${
                    sectionFilter === opt.value
                      ? "bg-violet-600 text-white"
                      : "glass text-gray-600 hover:bg-white/40"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">Mode</label>
            <div className="flex rounded-lg overflow-hidden border border-white/30">
              <button
                type="button"
                onClick={() => setHybrid(false)}
                className={`px-3 py-1.5 text-xs font-medium transition-all cursor-pointer ${
                  !hybrid
                    ? "bg-violet-600 text-white"
                    : "glass text-gray-600 hover:bg-white/40"
                }`}
              >
                Semantic
              </button>
              <button
                type="button"
                onClick={() => setHybrid(true)}
                className={`px-3 py-1.5 text-xs font-medium transition-all cursor-pointer ${
                  hybrid
                    ? "bg-violet-600 text-white"
                    : "glass text-gray-600 hover:bg-white/40"
                }`}
              >
                Hybrid
              </button>
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">Source</label>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="px-3 py-1.5 glass rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-violet-400/50"
            >
              <option value="">All sources</option>
              {SOURCES.filter(Boolean).map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">From</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="px-3 py-1.5 glass rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-violet-400/50"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">To</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="px-3 py-1.5 glass rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-violet-400/50"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">Limit</label>
            <input
              type="number"
              min={1}
              max={50}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="w-20 px-3 py-1.5 glass rounded-lg text-sm text-gray-700 focus:outline-none focus:ring-1 focus:ring-violet-400/50"
            />
          </div>
        </div>
      )}
    </form>
  );
}
