/**
 * opencode-db-to-messages
 *
 * Reads session info and messages directly from OpenCode's internal SQLite
 * database (~/.local/share/opencode/opencode.db), bypassing the REST API.
 *
 * This is the fallback path used by indexer-cli when OpenCode was started
 * without --port (e.g. `opencode -s <sessionId>`), in which case no HTTP
 * server is started and the REST API is unavailable.
 *
 * The DB is opened read-only — no WAL conflicts, no write contention.
 */

import path from "path";
import os from "os";
import type Database from "better-sqlite3";

/**
 * Loads better-sqlite3 lazily so that processes which never read the OpenCode
 * DB (e.g. every indexer when the REST API answers, or a PostgreSQL-backed
 * install) do not load the native module at import time.
 */
function loadBetterSqlite3(): typeof Database {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("better-sqlite3");
}
import type { FullMessage, MessageInfo, MessagePart } from "./types";

// ---------------------------------------------------------------------------
// Default DB path
// ---------------------------------------------------------------------------

function resolveOpenCodeDbPath(): string {
  return path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
}

// ---------------------------------------------------------------------------
// Row types (internal to this module)
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  title: string;
  directory: string;
}

interface MessageRow {
  id: string;
  data: string; // JSON: { role, time, agent, modelID, providerID, tokens, cost, ... }
}

interface PartRow {
  id: string;
  data: string; // JSON: { type, text?, callID?, tool?, state?, ... }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface OpenCodeSession {
  id: string;
  title: string;
  directory: string;
}

/**
 * Returns session metadata from the OpenCode DB, or null if not found.
 */
export function getSessionFromOpenCodeDb(
  sessionId: string,
  dbPath = resolveOpenCodeDbPath(),
): OpenCodeSession | null {
  let db: Database.Database | undefined;
  try {
    const BetterSqlite3 = loadBetterSqlite3();
    db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare("SELECT id, title, directory FROM session WHERE id = ?")
      .get(sessionId) as SessionRow | undefined;
    if (!row) return null;
    return { id: row.id, title: row.title, directory: row.directory };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Returns all messages for a session from the OpenCode DB, in chronological
 * order, shaped as FullMessage[] (same format as the REST API response).
 *
 * Returns null if the DB is not accessible.
 */
export function getMessagesFromOpenCodeDb(
  sessionId: string,
  dbPath = resolveOpenCodeDbPath(),
): FullMessage[] | null {
  let db: Database.Database | undefined;
  try {
    const BetterSqlite3 = loadBetterSqlite3();
    db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });

    const messageRows = db
      .prepare(
        "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created ASC",
      )
      .all(sessionId) as MessageRow[];

    if (messageRows.length === 0) return [];

    return messageRows.map((row) => {
      const msgData = JSON.parse(row.data) as {
        role: "user" | "assistant" | "tool";
        time?: { created?: number; completed?: number };
        agent?: string;
        modelID?: string;
        providerID?: string;
        tokens?: MessageInfo["tokens"];
        cost?: number;
      };

      // Same fields the REST API returns in `info` — keep them so analytics
      // (model, token usage, cost) are identical whichever path produced them.
      const info: MessageInfo = {
        id: row.id,
        role: msgData.role,
        time: msgData.time,
        agent: msgData.agent,
        modelID: msgData.modelID,
        providerID: msgData.providerID,
        tokens: msgData.tokens,
        cost: msgData.cost,
      };

      const partRows = db!
        .prepare(
          "SELECT id, data FROM part WHERE message_id = ? ORDER BY time_created ASC",
        )
        .all(row.id) as PartRow[];

      const parts: MessagePart[] = partRows.map((p) =>
        JSON.parse(p.data) as MessagePart,
      );

      return { info, parts };
    });
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
