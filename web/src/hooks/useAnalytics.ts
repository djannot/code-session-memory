import { useState, useEffect, useCallback } from "react";
import {
  getAnalyticsOverview,
  getAnalyticsTools,
  getAnalyticsMessages,
  type OverviewStats,
  type ToolUsageStat,
  type MessageStat,
  type AnalyticsParams,
} from "../api/client";

export function useAnalytics() {
  const [overview, setOverview] = useState<OverviewStats | null>(null);
  const [tools, setTools] = useState<ToolUsageStat[]>([]);
  const [messages, setMessages] = useState<MessageStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<AnalyticsParams>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, tl, msg] = await Promise.all([
        getAnalyticsOverview(filters),
        getAnalyticsTools(filters),
        getAnalyticsMessages(filters),
      ]);
      setOverview(ov);
      setTools(tl.tools);
      setMessages(msg.messages);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  return { overview, tools, messages, loading, error, filters, setFilters };
}
