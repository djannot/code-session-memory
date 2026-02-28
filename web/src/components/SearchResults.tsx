import type { QueryResult } from "../api/client";
import SearchResultCard from "./SearchResultCard";

export default function SearchResults({ results }: { results: QueryResult[] }) {
  if (results.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="text-sm text-gray-500">
        {results.length} result{results.length !== 1 ? "s" : ""}
      </div>
      {results.map((result, i) => (
        <SearchResultCard key={result.chunk_id} result={result} index={i + 1} />
      ))}
    </div>
  );
}
