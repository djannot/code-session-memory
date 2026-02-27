import { useState, useEffect } from "react";
import { getStatus, type StatusResult } from "../api/client";

export function useStatus() {
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetch() {
      setLoading(true);
      setError(null);
      try {
        const data = await getStatus();
        setStatus(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    }
    fetch();
  }, []);

  return { status, loading, error };
}
