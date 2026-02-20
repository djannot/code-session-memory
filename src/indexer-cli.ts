#!/usr/bin/env node
/**
 * indexer-cli — subprocess entry point called by the OpenCode plugin.
 *
 * Runs under Node.js (not Bun) so that native modules (better-sqlite3,
 * sqlite-vec) load correctly.
 *
 * Usage (called by plugin/memory.ts via the Bun $ shell):
 *   node /path/to/dist/src/indexer-cli.js <sessionId> <serverUrl>
 *
 * serverUrl is the URL of the already-running OpenCode server, passed in
 * by the plugin from the `serverUrl` context it receives at startup.
 * Uses plain fetch() to call the REST API — no ESM/CJS SDK dependency.
 */

import { indexNewMessages } from "./indexer";
import type { FullMessage } from "./types";

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

async function main() {
  const sessionId = process.argv[2];
  const serverUrl = process.argv[3];

  if (!sessionId || !serverUrl) {
    console.error("Usage: indexer-cli <sessionId> <serverUrl>");
    process.exit(1);
  }

  // Normalize: strip trailing slash
  const base = serverUrl.replace(/\/$/, "");

  const [session, messages] = await Promise.all([
    fetchJson<{ id: string; title?: string; directory?: string }>(
      `${base}/session/${sessionId}`,
    ),
    fetchJson<FullMessage[]>(`${base}/session/${sessionId}/message`),
  ]);

  const { indexed, skipped } = await indexNewMessages(
    {
      id: session.id,
      title: session.title,
      directory: session.directory,
    },
    messages,
  );

  // No output — the plugin runs this silently via Bun's $.quiet()
}

main().catch((err) => {
  console.error(
    "[opencode-memory] indexer-cli error:",
    err instanceof Error ? err.message : String(err),
  );
  process.exit(1);
});
