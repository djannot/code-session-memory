import { useState, useEffect } from "react";
import { getSession, deleteSessionById, type SessionRow, type ChunkRow } from "../api/client";

export function useSessionDetail(sessionId: string) {
  const [session, setSession] = useState<SessionRow | null>(null);
  const [chunks, setChunks] = useState<ChunkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetch() {
      setLoading(true);
      setError(null);
      try {
        const data = await getSession(sessionId);
        setSession(data.session);
        setChunks(data.chunks);
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

  return { session, chunks, loading, error, deleteSession: deleteCurrentSession };
}
