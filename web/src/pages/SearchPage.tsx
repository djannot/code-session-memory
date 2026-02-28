import SearchBar from "../components/SearchBar";
import SearchResults from "../components/SearchResults";
import { useSearch } from "../hooks/useSearch";

export default function SearchPage() {
  const { results, loading, error, hasSearched, search } = useSearch();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-gray-900 mb-1">Search</h1>
        <p className="text-sm text-gray-500">
          Semantic search across all indexed AI coding sessions
        </p>
      </div>

      <SearchBar onSearch={search} loading={loading} />

      {error && (
        <div className="glass rounded-xl p-4 text-sm text-red-700 bg-red-100/30 shadow-sm">
          {error}
        </div>
      )}

      {hasSearched && !loading && results.length === 0 && !error && (
        <div className="text-center py-12 text-gray-400">
          No results found. Try a different query.
        </div>
      )}

      <SearchResults results={results} />
    </div>
  );
}
