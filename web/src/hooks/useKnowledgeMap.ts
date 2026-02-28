import { useState, useEffect, useCallback } from "react";
import {
  getMapStatus,
  computeMapCoords,
  getMapOverview,
  searchWithMap,
  getMapNeighbors,
} from "../api/client";
import type { MapStatus, VisualizationPayload, VisualizationPoint, QueryResult } from "../api/client";

export interface MapFilters {
  sectionFilter?: string;
  minContentLength?: number;
}

export function useKnowledgeMap() {
  const [status, setStatus] = useState<MapStatus | null>(null);
  const [visualization, setVisualization] = useState<VisualizationPayload | null>(null);
  const [searchResults, setSearchResults] = useState<QueryResult[]>([]);
  const [selectedNode, setSelectedNode] = useState<VisualizationPoint | null>(null);
  const [loading, setLoading] = useState(false);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await getMapStatus();
      setStatus(s);
      return s;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  const compute = useCallback(async (filters?: MapFilters) => {
    setComputing(true);
    setError(null);
    try {
      await computeMapCoords();
      const s = await refreshStatus();
      if (s?.ready) {
        setLoading(true);
        const { visualization } = await getMapOverview({
          sectionFilter: filters?.sectionFilter,
          minContentLength: filters?.minContentLength,
        });
        setVisualization(visualization);
        setLoading(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setComputing(false);
    }
  }, [refreshStatus]);

  const loadOverview = useCallback(async (filters?: MapFilters) => {
    setLoading(true);
    setError(null);
    setSearchResults([]);
    setSelectedNode(null);
    try {
      const { visualization } = await getMapOverview({
        sectionFilter: filters?.sectionFilter,
        minContentLength: filters?.minContentLength,
      });
      setVisualization(visualization);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const search = useCallback(async (queryText: string, source?: string, filters?: MapFilters) => {
    setLoading(true);
    setError(null);
    setSelectedNode(null);
    try {
      const { results, visualization } = await searchWithMap({
        queryText,
        source,
        limit: 10,
        sectionFilter: filters?.sectionFilter,
        minContentLength: filters?.minContentLength,
      });
      setSearchResults(results);
      setVisualization(visualization);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadNeighbors = useCallback(async (chunkId: string): Promise<VisualizationPayload | null> => {
    try {
      const { visualization } = await getMapNeighbors(chunkId, 12);
      return visualization;
    } catch {
      return null;
    }
  }, []);

  return {
    status,
    visualization,
    setVisualization,
    searchResults,
    selectedNode,
    setSelectedNode,
    loading,
    computing,
    error,
    compute,
    loadOverview,
    search,
    loadNeighbors,
    refreshStatus,
  };
}
