import { useState, useEffect } from "react";
import {
  getSession,
  deleteSessionById,
  getSessionAnalytics,
  type SessionRow,
  type ChunkRow,
  type SessionAnalytics,
} from "../api/client";

export function useSessionDetail(sessionId: string) {
  const [session, setSession] = useState<SessionRow | null>(null);
  const [chunks, setChunks] = useState<ChunkRow[]>([]);
  const [analytics, setAnalytics] = useState<SessionAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetch() {
      setLoading(true);
      setError(null);
      try {
        const [data, analyticsData] = await Promise.all([
          getSession(sessionId),
          getSessionAnalytics(sessionId).catch(() => null),
        ]);
        setSession(data.session);
        setChunks(data.chunks);
        setAnalytics(analyticsData);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }
    fetch();
  }, [sessionId]);

  async function deleteCurrentSession() {
    await deleteSessionById(sessionId);
  }

  return { session, chunks, analytics, loading, error, deleteSession: deleteCurrentSession };
}
