import { useState } from "react";
import { searchSessions, type QueryResult } from "../api/client";

export function useSearch() {
  const [results, setResults] = useState<QueryResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  async function search(params: {
    queryText: string;
    source?: string;
    limit?: number;
    fromDate?: string;
    toDate?: string;
  }) {
    setLoading(true);
    setError(null);
    setHasSearched(true);
    try {
      const data = await searchSessions(params);
      setResults(data.results);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  return { results, loading, error, hasSearched, search };
}
