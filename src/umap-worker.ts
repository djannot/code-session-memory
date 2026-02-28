import { parentPort } from "worker_threads";

interface UmapRequest {
  embeddings: number[][];
}

interface UmapResponse {
  coords: Array<{ x: number; y: number }>;
}

function normalizeCoords(coords: number[][]): Array<{ x: number; y: number }> {
  if (coords.length === 0) return [];
  const xs = coords.map((p) => p[0]);
  const ys = coords.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;

  return coords.map((p) => ({
    x: ((p[0] - minX) / spanX) * 2 - 1,
    y: ((p[1] - minY) / spanY) * 2 - 1,
  }));
}

if (!parentPort) {
  process.exit(1);
}

parentPort.on("message", async (payload: UmapRequest) => {
  try {
    const { UMAP } = await import("umap-js");
    const embeddings = payload.embeddings || [];

    if (embeddings.length === 0) {
      parentPort?.postMessage({ coords: [] } as UmapResponse);
      return;
    }

    if (embeddings.length < 3) {
      const fallback = embeddings.map((_, index) => ({
        x: index === 0 ? 0 : 0.2 * index,
        y: index === 0 ? 0 : -0.2 * index,
      }));
      parentPort?.postMessage({ coords: fallback } as UmapResponse);
      return;
    }

    const umap = new UMAP({
      nComponents: 2,
      nNeighbors: Math.min(15, Math.max(2, Math.floor(embeddings.length / 10))),
      minDist: 0.15,
      spread: 1.0,
      random: Math.random,
    });

    const rawCoords = umap.fit(embeddings) as number[][];
    const coords = normalizeCoords(rawCoords);
    parentPort?.postMessage({ coords } as UmapResponse);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "UMAP projection failed";
    parentPort?.postMessage({ error: message });
  }
});
