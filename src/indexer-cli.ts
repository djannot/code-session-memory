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

import { resolveDbPath, openDatabase } from "./database";
import { indexNewMessages } from "./indexer";
import { getSessionFromOpenCodeDb, getMessagesFromOpenCodeDb } from "./opencode-db-to-messages";
import type { FullMessage } from "./types";

const FETCH_RETRIES = 3;
const FETCH_RETRY_DELAY_MS = 500;

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}: ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Fetches JSON from the OpenCode REST API with retries.
 * If the server is unreachable (network error), retries up to FETCH_RETRIES
 * times with a short delay. This handles the case where session.idle fires
 * just as OpenCode is shutting down or restarting.
 *
 * Returns null if the server remains unreachable after all retries — the
 * caller should treat this as a graceful no-op (session is gone, nothing to index).
 *
 * Only retries on network-level errors (fetch failed). HTTP errors (4xx/5xx)
 * are propagated immediately.
 */
async function fetchJsonWithRetry<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    try {
      return await fetchJson<T>(url);
    } catch (err) {
      // TypeError with message "fetch failed" covers all network-level failures:
      // ECONNREFUSED, EADDRNOTAVAIL, ENOTFOUND, bad port, IPv6 unreachable, etc.
      const isNetworkError = err instanceof TypeError && err.message === "fetch failed";
      if (isNetworkError) {
        if (attempt < FETCH_RETRIES) {
          await new Promise((r) => setTimeout(r, FETCH_RETRY_DELAY_MS));
          continue;
        }
        // All retries exhausted — server is gone, signal graceful no-op.
        return null;
      }
      // Non-network error (e.g. HTTP 4xx/5xx) — propagate immediately.
      throw err;
    }
  }
  return null;
}

async function main() {
  const sessionId = process.argv[2];
  const serverUrl = process.argv[3];

  if (!sessionId || !serverUrl) {
    process.stderr.write("Usage: indexer-cli <sessionId> <serverUrl>\n");
    process.exit(1);
  }

  // Normalize the server URL:
  // - Strip trailing slash
  // - Rewrite IPv6 loopback [::1] and "localhost" to 127.0.0.1 (IPv4).
  //   OpenCode binds to 127.0.0.1 by default, but when started with -s it may
  //   construct serverUrl using "localhost", which on many systems resolves to
  //   ::1 (IPv6) first. Node's fetch then fails with ECONNREFUSED because the
  //   server isn't listening on IPv6.
  const base = serverUrl
    .replace(/\/$/, "")
    .replace(/^http:\/\/\[::1\]/i, "http://127.0.0.1")
    .replace(/^http:\/\/localhost/i, "http://127.0.0.1");

  // Fetch session + messages in parallel via REST API, with retry on network errors.
  // Returns null on any network-level failure (server not running / no --port).
  const [fetchedSession, fetchedMessages] = await Promise.all([
    fetchJsonWithRetry<{ id: string; title?: string; directory?: string }>(
      `${base}/session/${sessionId}`,
    ),
    fetchJsonWithRetry<FullMessage[]>(`${base}/session/${sessionId}/message`),
  ]);

  let session: { id: string; title?: string; directory?: string };
  let messages: FullMessage[];

  if (fetchedSession && fetchedMessages) {
    // Happy path: REST API responded.
    session = fetchedSession;
    messages = fetchedMessages;
  } else {
    // REST API unavailable (e.g. OpenCode started with -s and no --port, so no
    // HTTP server is running). Fall back to reading directly from OpenCode's
    // internal SQLite DB.
    const dbSession = getSessionFromOpenCodeDb(sessionId);
    const dbMessages = getMessagesFromOpenCodeDb(sessionId);

    if (!dbSession || !dbMessages) {
      // Neither source available — nothing to index, exit cleanly.
      process.exit(0);
    }

    session = dbSession;
    messages = dbMessages;
  }

  const dbPath = resolveDbPath();
  const db = openDatabase({ dbPath });
  try {
    await indexNewMessages(
      db,
      { id: session.id, title: session.title, directory: session.directory },
      messages,
      "opencode",
    );
  } finally {
    db.close();
  }

  // No output — the plugin runs this silently via Bun's $.quiet()
}

main().catch((err) => {
  const url = process.argv[3] ?? "(no url)";
  process.stderr.write(
    `[code-session-memory] indexer-cli error: ${err instanceof Error ? err.message : String(err)} (serverUrl: ${url})\n`,
  );
  process.exit(1);
});
