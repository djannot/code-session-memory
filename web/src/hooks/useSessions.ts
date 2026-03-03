import { useState, useEffect, useCallback } from "react";
import { getSessions, deleteSessionById, bulkDeleteSessions, purgeOldSessions, type SessionRow } from "../api/client";

export function useSessions() {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<{ source?: string; from?: string; to?: string }>({});

  const fetchSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getSessions(filters);
      setSessions(data.sessions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchSessions();
  }, [fetchSessions]);

  async function deleteSession(id: string) {
    await deleteSessionById(id);
    setSessions((prev) => prev.filter((s) => s.session_id !== id));
  }

  async function bulkDelete(ids: string[]) {
    const result = await bulkDeleteSessions(ids);
    setSessions((prev) => prev.filter((s) => !ids.includes(s.session_id)));
    return result.deleted;
  }

  async function purgeSessions(days: number) {
    const result = await purgeOldSessions(days);
    await fetchSessions();
    return result;
  }

  return { sessions, loading, error, filters, setFilters, deleteSession, bulkDelete, purgeSessions, refresh: fetchSessions };
}
