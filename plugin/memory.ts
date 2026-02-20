/**
 * opencode-memory plugin
 *
 * Listens for session.idle events and incrementally indexes new messages
 * into the sqlite-vec database by spawning a Node.js subprocess (so that
 * native modules like better-sqlite3 / sqlite-vec load correctly).
 *
 * Install this file at:
 *   ~/.config/opencode/plugins/opencode-memory.ts
 *
 * Or run:
 *   npx opencode-memory install
 *
 * Required environment variable:
 *   OPENAI_API_KEY  — used for generating embeddings
 */

import type { Plugin } from "@opencode-ai/plugin";

// The path below is replaced with an absolute path at install time.
const INDEXER_CLI = "OPENCODE_MEMORY_INDEXER_PATH";

const MemoryPlugin: Plugin = async ({ $, serverUrl }) => {
  return {
    event: async ({ event }) => {
      if (event.type !== "session.idle") return;

      const sessionId = event.properties.sessionID;
      if (!sessionId) return;

      try {
        await $`node ${INDEXER_CLI} ${sessionId} ${serverUrl.toString()}`.quiet();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[opencode-memory] Failed to index session ${sessionId}: ${msg}`);
      }
    },
  };
};

export default MemoryPlugin;
export { MemoryPlugin };
