import { useState, useEffect, useCallback } from "react";
import {
  getAnalyticsOverview,
  getAnalyticsTools,
  getAnalyticsMessages,
  getAnalyticsModels,
  type OverviewStats,
  type ToolUsageStat,
  type MessageStat,
  type ModelStat,
  type AnalyticsParams,
} from "../api/client";

export function useAnalytics() {
  const [overview, setOverview] = useState<OverviewStats | null>(null);
  const [tools, setTools] = useState<ToolUsageStat[]>([]);
  const [messages, setMessages] = useState<MessageStat[]>([]);
  const [models, setModels] = useState<ModelStat[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<AnalyticsParams>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, tl, msg, md] = await Promise.all([
        getAnalyticsOverview(filters),
        getAnalyticsTools(filters),
        getAnalyticsMessages(filters),
        getAnalyticsModels(filters),
      ]);
      setOverview(ov);
      setTools(tl.tools);
      setMessages(msg.messages);
      setModels(md.models);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  return { overview, tools, messages, models, loading, error, filters, setFilters };
}
