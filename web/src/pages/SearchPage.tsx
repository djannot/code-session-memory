import SearchBar from "../components/SearchBar";
import SearchResults from "../components/SearchResults";
import { useSearch } from "../hooks/useSearch";

export default function SearchPage() {
  const { results, loading, error, hasSearched, search } = useSearch();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-100 mb-1">Search</h1>
        <p className="text-sm text-slate-500">
          Semantic search across all indexed AI coding sessions
        </p>
      </div>

      <SearchBar onSearch={search} loading={loading} />

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-xl p-4 text-sm text-red-300">
          {error}
        </div>
      )}

      {hasSearched && !loading && results.length === 0 && !error && (
        <div className="text-center py-12 text-slate-500">
          No results found. Try a different query.
        </div>
      )}

      <SearchResults results={results} />
    </div>
  );
}
