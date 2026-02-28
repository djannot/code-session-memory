import { useRef, useEffect, useState, useCallback } from "react";
import { useKnowledgeMap } from "../hooks/useKnowledgeMap";
import type { MapFilters } from "../hooks/useKnowledgeMap";
import type { VisualizationPoint, VisualizationPayload } from "../api/client";
import { getChunkContent } from "../api/client";
import ForceGraph from "force-graph";
import SourceBadge from "../components/SourceBadge";
import ChunkView from "../components/ChunkView";

// ---------------------------------------------------------------------------
// Filter options
// ---------------------------------------------------------------------------

const TYPE_OPTIONS = [
  { value: "", label: "All types" },
  { value: "user", label: "User" },
  { value: "assistant", label: "Assistant" },
  { value: "tool", label: "Tool" },
] as const;

const SIZE_OPTIONS = [
  { value: 0, label: "All sizes" },
  { value: 100, label: "> 100 chars" },
  { value: 500, label: "> 500 chars" },
  { value: 1000, label: "> 1K chars" },
  { value: 5000, label: "> 5K chars" },
] as const;

const MIN_SCORE_OPTIONS = [
  { value: 0, label: "Any score" },
  { value: 0.3, label: "> 0.3" },
  { value: 0.4, label: "> 0.4" },
  { value: 0.5, label: "> 0.5" },
  { value: 0.6, label: "> 0.6" },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MapNode = VisualizationPoint & { fx: number; fy: number };
type MapLink = { source: string; target: string; session_id: string };

function buildLinks(nodes: VisualizationPoint[]): MapLink[] {
  const links: MapLink[] = [];
  const seen = new Set<string>();

  // Only link non-map nodes (result, neighbor, focus) — skip background map nodes
  const activeNodes = nodes.filter((n) => n.type !== "map");
  const bySession = new Map<string, VisualizationPoint[]>();
  activeNodes.forEach((n) => {
    if (!n.session_id) return;
    if (!bySession.has(n.session_id)) bySession.set(n.session_id, []);
    bySession.get(n.session_id)!.push(n);
  });

  for (const group of bySession.values()) {
    if (group.length < 2) continue;
    // Sort by url (message) then chunk_index within each message
    group.sort((a, b) => {
      if (a.url !== b.url) return a.url < b.url ? -1 : 1;
      return a.chunk_index - b.chunk_index;
    });
    for (let i = 0; i < group.length - 1; i++) {
      const key = `${group[i].id}|${group[i + 1].id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({
        source: group[i].id,
        target: group[i + 1].id,
        session_id: group[i].session_id,
      });
      if (links.length > 1500) break;
    }
    if (links.length > 1500) break;
  }

  return links;
}

const typePriority = (t: string) => {
  if (t === "focus") return 3;
  if (t === "result") return 2;
  if (t === "neighbor") return 1;
  return 0;
};

// ---------------------------------------------------------------------------
// Navigation history hook
// ---------------------------------------------------------------------------

function useNodeHistory() {
  // Use refs for the mutable data to avoid stale closures
  const historyRef = useRef<VisualizationPoint[]>([]);
  const indexRef = useRef(-1);
  const [, rerender] = useState(0);

  const push = useCallback((node: VisualizationPoint) => {
    // Trim forward history and append
    historyRef.current = [...historyRef.current.slice(0, indexRef.current + 1), node];
    indexRef.current = historyRef.current.length - 1;
    rerender((n) => n + 1);
  }, []);

  const canGoBack = indexRef.current > 0;
  const canGoForward = indexRef.current < historyRef.current.length - 1;

  const goBack = useCallback((): VisualizationPoint | null => {
    if (indexRef.current <= 0) return null;
    indexRef.current -= 1;
    rerender((n) => n + 1);
    return historyRef.current[indexRef.current];
  }, []);

  const goForward = useCallback((): VisualizationPoint | null => {
    if (indexRef.current >= historyRef.current.length - 1) return null;
    indexRef.current += 1;
    rerender((n) => n + 1);
    return historyRef.current[indexRef.current];
  }, []);

  const clear = useCallback(() => {
    historyRef.current = [];
    indexRef.current = -1;
    rerender((n) => n + 1);
  }, []);

  return { push, goBack, goForward, canGoBack, canGoForward, clear };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function KnowledgeMapPage() {
  const {
    status,
    visualization,
    selectedNode,
    setSelectedNode,
    loading,
    computing,
    error,
    compute,
    loadOverview,
    search,
    loadNeighbors,
  } = useKnowledgeMap();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const graphRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const focusIdRef = useRef<string | null>(null);
  const focusDocUrlRef = useRef<string | null>(null);
  const [, forceRender] = useState(0);
  const [hasLoadedOverview, setHasLoadedOverview] = useState(false);
  const zoomRef = useRef(1);
  const [chunkContent, setChunkContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const nodeHistory = useNodeHistory();
  const [sectionFilter, setSectionFilter] = useState("");
  const [minContentLength, setMinContentLength] = useState(0);
  const [minScore, setMaxDistance] = useState(0);

  const getFilters = useCallback((): MapFilters => ({
    sectionFilter: sectionFilter || undefined,
    minContentLength: minContentLength || undefined,
  }), [sectionFilter, minContentLength]);

  // Auto-load overview when status indicates ready
  useEffect(() => {
    if (status?.ready && !hasLoadedOverview && !visualization) {
      loadOverview(getFilters());
      setHasLoadedOverview(true);
    }
  }, [status, hasLoadedOverview, visualization, loadOverview, getFilters]);

  // Fetch chunk content when selected node changes
  useEffect(() => {
    if (!selectedNode) {
      setChunkContent(null);
      return;
    }
    let cancelled = false;
    setContentLoading(true);
    setChunkContent(null);
    getChunkContent(selectedNode.id)
      .then(({ content }) => {
        if (!cancelled) setChunkContent(content);
      })
      .catch(() => {
        if (!cancelled) setChunkContent(null);
      })
      .finally(() => {
        if (!cancelled) setContentLoading(false);
      });
    return () => { cancelled = true; };
  }, [selectedNode]);

  const resizeGraph = useCallback(() => {
    if (!graphRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    graphRef.current.width(Math.max(1, rect.width));
    graphRef.current.height(Math.max(1, rect.height));
  }, []);

  const selectNode = useCallback((node: VisualizationPoint, addToHistory = true) => {
    focusIdRef.current = node.id;
    focusDocUrlRef.current = node.url || null;
    setSelectedNode(node);
    if (addToHistory) nodeHistory.push(node);
    forceRender((n) => n + 1);

    if (graphRef.current?.centerAt) {
      graphRef.current.centerAt(node.x, node.y, 500);
    }
    if (graphRef.current?.zoom) {
      graphRef.current.zoom(2.4, 500);
    }
  }, [setSelectedNode, nodeHistory]);

  const mergeVisualization = useCallback((newViz: VisualizationPayload) => {
    if (!graphRef.current) return;
    const existing = graphRef.current.graphData();
    const existingNodes = (existing?.nodes || []) as MapNode[];

    const merged = new Map<string, MapNode>();
    existingNodes.forEach((n: MapNode) => merged.set(n.id, n));
    newViz.points.forEach((n) => {
      const node: MapNode = { ...n, fx: n.x, fy: n.y };
      const existing = merged.get(n.id);
      if (!existing || typePriority(n.type) >= typePriority(existing.type)) {
        merged.set(n.id, node);
      }
    });

    const nodes = Array.from(merged.values());
    nodes.sort((a, b) => typePriority(a.type) - typePriority(b.type));
    const links = buildLinks(nodes);

    graphRef.current.graphData({ nodes, links });
    graphRef.current.cooldownTicks(0);
  }, []);

  // Render / update the force graph when visualization changes
  useEffect(() => {
    if (!visualization || !containerRef.current) return;

    // Apply score filter: keep result nodes above threshold + their neighbors,
    // hide map background nodes when filtering is active
    const filteredPoints = minScore > 0
      ? visualization.points.filter((p) => {
          if (p.type === "map") return false; // hide background when filtering
          if (p.type === "neighbor" || p.type === "focus") return true;
          // result nodes: filter by score
          return p.score !== null && p.score >= minScore;
        })
      : visualization.points;

    const nodes: MapNode[] = filteredPoints.map((p) => ({
      ...p,
      fx: p.x,
      fy: p.y,
    }));
    nodes.sort((a, b) => typePriority(a.type) - typePriority(b.type));

    const links = buildLinks(filteredPoints);

    if (!graphRef.current) {
      const graph = new ForceGraph(containerRef.current);
      graphRef.current = graph;

      graph
        .nodeId("id")
        .backgroundColor("#0f1624")
        .linkColor(((link: MapLink) => {
          const focusNode = (graphRef.current?.graphData()?.nodes as MapNode[])?.find(
            (n: MapNode) => n.id === focusIdRef.current
          );
          return focusNode && link.session_id === focusNode.session_id
            ? "rgba(255, 213, 79, 0.5)"
            : "rgba(138, 148, 166, 0.25)";
        }) as any) // eslint-disable-line @typescript-eslint/no-explicit-any
        .linkWidth(((link: MapLink) => {
          const focusNode = (graphRef.current?.graphData()?.nodes as MapNode[])?.find(
            (n: MapNode) => n.id === focusIdRef.current
          );
          return focusNode && link.session_id === focusNode.session_id ? 1.5 : 0.5;
        }) as any) // eslint-disable-line @typescript-eslint/no-explicit-any
        .nodeCanvasObjectMode((() => "replace") as any) // eslint-disable-line @typescript-eslint/no-explicit-any
        .nodeLabel(((node: MapNode) => {
          const kw = node.keywords?.length ? node.keywords.join(" \u00b7 ") : "";
          const heading = node.heading_hierarchy || node.section || "";
          return zoomRef.current < 0.9 ? kw : heading;
        }) as any) // eslint-disable-line @typescript-eslint/no-explicit-any
        .nodeCanvasObject(((node: MapNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
          const isFocus = node.type === "focus" || node.id === focusIdRef.current;
          const baseRadius =
            node.type === "result" ? 6 :
            node.type === "focus" ? 7 :
            node.type === "neighbor" ? 4 : 2.4;
          const radius = baseRadius / Math.max(globalScale, 1);

          const color =
            isFocus || node.type === "result" ? "#ffd54f" :
            node.type === "neighbor" ? "#7aa2ff" : "#8a94a6";

          ctx.beginPath();
          ctx.globalAlpha = node.type === "map" ? 0.4 : 1;
          ctx.fillStyle = color;
          ctx.shadowColor = node.type === "result" || isFocus ? color : "transparent";
          ctx.shadowBlur = node.type === "result" || isFocus ? 14 : 0;
          ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI, false);
          ctx.fill();

          if (isFocus) {
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1.5 / Math.max(globalScale, 1);
            ctx.stroke();
          }
          ctx.shadowBlur = 0;
          ctx.globalAlpha = 1;
        }) as any) // eslint-disable-line @typescript-eslint/no-explicit-any
        .onNodeClick((async (node: MapNode) => {
          selectNode(node);
          const neighborViz = await loadNeighbors(node.id);
          if (neighborViz) {
            mergeVisualization(neighborViz);
          }
        }) as any); // eslint-disable-line @typescript-eslint/no-explicit-any

      if (graph.onZoom) {
        graph.onZoom(({ k }: { k: number }) => {
          zoomRef.current = k;
        });
      }
    }

    graphRef.current.graphData({ nodes, links });
    graphRef.current.cooldownTicks(0);

    resizeGraph();

    if (visualization.center && graphRef.current.centerAt) {
      graphRef.current.centerAt(visualization.center.x, visualization.center.y);
    }
    if (graphRef.current.zoomToFit) {
      setTimeout(() => {
        resizeGraph();
        graphRef.current?.zoomToFit?.(500, 60);
      }, 50);
    }
  }, [visualization, minScore]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    window.addEventListener("resize", resizeGraph);
    return () => window.removeEventListener("resize", resizeGraph);
  }, [resizeGraph]);

  // Cleanup graph on unmount
  useEffect(() => {
    return () => {
      if (graphRef.current?._destructor) {
        graphRef.current._destructor();
        graphRef.current = null;
      }
    };
  }, []);

  const handleSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (query.trim()) search(query.trim(), undefined, getFilters());
    },
    [query, search, getFilters],
  );

  const handleReset = useCallback(() => {
    setQuery("");
    setSectionFilter("");
    setMinContentLength(0);
    setMaxDistance(0);
    focusIdRef.current = null;
    focusDocUrlRef.current = null;
    setSelectedNode(null);
    setChunkContent(null);
    nodeHistory.clear();
    loadOverview();
  }, [loadOverview, setSelectedNode, nodeHistory]);

  // Re-load when filters change (only if we have an active overview, not during search)
  const handleFilterChange = useCallback((newSection: string, newMinLen: number) => {
    setSectionFilter(newSection);
    setMinContentLength(newMinLen);
    const filters: MapFilters = {
      sectionFilter: newSection || undefined,
      minContentLength: newMinLen || undefined,
    };
    if (query.trim()) {
      search(query.trim(), undefined, filters);
    } else {
      loadOverview(filters);
    }
  }, [query, search, loadOverview]);

  const handleGoBack = useCallback(() => {
    const node = nodeHistory.goBack();
    if (node) selectNode(node, false);
  }, [nodeHistory, selectNode]);

  const handleGoForward = useCallback(() => {
    const node = nodeHistory.goForward();
    if (node) selectNode(node, false);
  }, [nodeHistory, selectNode]);

  // ------ Render ------

  const needsInitialCompute = status && status.coordsCount === 0 && status.totalChunks > 0 && !computing;
  const noChunks = status && status.totalChunks === 0;
  const isStale = status && status.coordsCount > 0 && status.totalChunks > status.coordsCount;
  const newChunkCount = status ? status.totalChunks - status.coordsCount : 0;

  return (
    <div className="flex flex-col" style={{ height: "calc(100vh - 5rem)" }}>
      {/* Top bar: search + controls */}
      <div className="flex items-center gap-3 mb-2 flex-shrink-0">
        <form onSubmit={handleSearch} className="flex-1 flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the knowledge map..."
            className="flex-1 px-3 py-2 text-sm rounded-lg glass border border-gray-200 focus:outline-none focus:ring-2 focus:ring-violet-400"
          />
          <button
            type="submit"
            disabled={loading || computing || !query.trim()}
            className="px-4 py-2 text-sm font-medium text-white bg-violet-600 rounded-lg hover:bg-violet-700 disabled:opacity-50 transition-colors"
          >
            Search
          </button>
          <button
            type="button"
            onClick={handleReset}
            disabled={computing}
            className="px-3 py-2 text-sm text-gray-600 rounded-lg glass hover:bg-white/60 disabled:opacity-50 transition-colors"
          >
            Reset
          </button>
        </form>

        {/* Stale indicator + recompute */}
        {isStale && !computing && (
          <button
            onClick={() => compute(getFilters())}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-700 bg-amber-100/60 rounded-lg hover:bg-amber-100 transition-colors whitespace-nowrap"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            {newChunkCount} new chunk{newChunkCount !== 1 ? "s" : ""} — Recompute
          </button>
        )}

        {/* Legend */}
        <div className="flex items-center gap-3 text-xs text-gray-500 flex-shrink-0">
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: "#ffd54f" }} />
            Result
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: "#7aa2ff" }} />
            Neighbor
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full opacity-50" style={{ background: "#8a94a6" }} />
            Map
          </span>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-3 mb-3 flex-shrink-0">
        <span className="text-xs text-gray-400">Filters:</span>
        <div className="flex items-center gap-1">
          {TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => handleFilterChange(opt.value, minContentLength)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                sectionFilter === opt.value
                  ? "bg-violet-100 text-violet-700 font-medium"
                  : "text-gray-500 hover:bg-gray-100"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="w-px h-4 bg-gray-200" />
        <select
          value={minContentLength}
          onChange={(e) => handleFilterChange(sectionFilter, Number(e.target.value))}
          className="px-2 py-1 text-xs rounded-md border border-gray-200 bg-white/60 text-gray-600 focus:outline-none focus:ring-1 focus:ring-violet-400"
        >
          {SIZE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <div className="w-px h-4 bg-gray-200" />
        <select
          value={minScore}
          onChange={(e) => setMaxDistance(Number(e.target.value))}
          className="px-2 py-1 text-xs rounded-md border border-gray-200 bg-white/60 text-gray-600 focus:outline-none focus:ring-1 focus:ring-violet-400"
        >
          {MIN_SCORE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {/* Error */}
      {error && (
        <div className="glass rounded-xl p-3 text-sm text-red-700 bg-red-100/30 shadow-sm mb-3 flex-shrink-0">
          {error}
        </div>
      )}

      {/* Main area: graph + sidebar */}
      <div className="flex-1 flex gap-3 min-h-0">
        {/* Graph */}
        <div className="flex-1 rounded-xl overflow-hidden relative" style={{ background: "#0f1624" }}>
          {noChunks && !computing && (
            <div className="absolute inset-0 flex items-center justify-center z-10 text-white/50 text-sm">
              No chunks indexed yet. Index some sessions first.
            </div>
          )}
          {needsInitialCompute && (
            <div className="absolute inset-0 flex flex-col items-center justify-center z-10">
              <p className="text-white/60 text-sm mb-4">
                {status.totalChunks.toLocaleString()} chunks found. Compute 2D coordinates to visualize the knowledge map.
              </p>
              <button
                onClick={compute}
                className="px-5 py-2.5 text-sm font-medium text-white bg-violet-600 rounded-lg hover:bg-violet-700 transition-colors"
              >
                Compute Map
              </button>
            </div>
          )}
          {computing && (
            <div className="absolute inset-0 flex flex-col items-center justify-center z-20 bg-[#0f1624]/80">
              <svg className="animate-spin h-8 w-8 text-violet-400 mb-3" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <p className="text-white/70 text-sm">
                Computing UMAP projection for {status?.totalChunks.toLocaleString()} chunks...
              </p>
              <p className="text-white/40 text-xs mt-1">This may take a while for large databases</p>
            </div>
          )}
          {loading && !computing && (
            <div className="absolute inset-0 flex items-center justify-center z-10">
              <div className="text-white/40 text-sm">Loading...</div>
            </div>
          )}
          <div ref={containerRef} className="w-full h-full" />
        </div>

        {/* Preview sidebar */}
        {selectedNode && (
          <div className="w-96 flex-shrink-0 overflow-y-auto flex flex-col gap-3">
            {/* Back / Forward navigation */}
            <div className="flex items-center gap-1">
              <button
                onClick={handleGoBack}
                disabled={!nodeHistory.canGoBack}
                className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-default transition-colors"
                title="Go back"
              >
                <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <button
                onClick={handleGoForward}
                disabled={!nodeHistory.canGoForward}
                className="p-1 rounded hover:bg-gray-100 disabled:opacity-30 disabled:cursor-default transition-colors"
                title="Go forward"
              >
                <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
              <div className="flex-1" />
              {selectedNode.source && <SourceBadge source={selectedNode.source} />}
              {selectedNode.session_title && (
                <span className="text-xs text-gray-500 truncate max-w-[140px]">
                  {selectedNode.session_title}
                </span>
              )}
              {selectedNode.score !== null && (
                <span className="text-xs font-mono text-gray-400">
                  {selectedNode.score.toFixed(4)}
                </span>
              )}
              <button
                onClick={() => {
                  focusIdRef.current = null;
                  focusDocUrlRef.current = null;
                  setSelectedNode(null);
                  setChunkContent(null);
                  forceRender((n) => n + 1);
                }}
                className="p-1 rounded hover:bg-gray-100 transition-colors"
                title="Close preview"
              >
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Chunk content using ChunkView (same as sessions page) */}
            {contentLoading ? (
              <div className="glass rounded-xl p-4 text-sm text-gray-400 italic">Loading content...</div>
            ) : chunkContent ? (
              <ChunkView
                chunk={{
                  chunk_id: selectedNode.id,
                  chunk_index: selectedNode.chunk_index,
                  total_chunks: selectedNode.total_chunks,
                  section: selectedNode.section || "",
                  heading_hierarchy: selectedNode.heading_hierarchy || "",
                  content: chunkContent,
                  url: selectedNode.url,
                }}
                index={selectedNode.chunk_index}
                total={selectedNode.total_chunks}
              />
            ) : (
              <div className="glass rounded-xl p-4 text-sm text-gray-400 italic">Content not available</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
