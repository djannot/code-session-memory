/**
 * Reads a Cursor conversation from the SQLite state.vscdb and converts it
 * to the FullMessage[] format used by the indexer.
 *
 * Cursor stores conversations in:
 *   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *
 * Key namespaces used:
 *   composerData:<composerId>          — session metadata + ordered bubble headers
 *   bubbleId:<composerId>:<bubbleId>   — individual message bubbles
 *
 * Bubble types:
 *   type 1 — user message   (field: text)
 *   type 2 — AI message     (field: text, or toolFormerData for tool calls)
 *
 * Tool call bubbles have toolFormerData:
 *   { name, rawArgs (JSON string), result (JSON string), status }
 *
 * Empty AI bubbles (no text, no toolFormerData) are placeholder/streaming
 * artifacts — we skip them.
 */

import Database from "better-sqlite3";
import path from "path";
import os from "os";
import type { FullMessage, MessagePart } from "./types";

// ---------------------------------------------------------------------------
// Raw DB shapes
// ---------------------------------------------------------------------------

interface BubbleHeader {
  bubbleId: string;
  type: 1 | 2; // 1=user, 2=AI
}

interface ToolFormerData {
  name?: string;
  rawArgs?: string;   // JSON string
  result?: string;    // JSON string
  status?: string;    // "completed" | "failed" | "cancelled"
  toolCallId?: string;
}

interface CursorBubble {
  _v?: number;
  type: 1 | 2;
  bubbleId: string;
  text?: string;
  isThought?: boolean;
  toolFormerData?: ToolFormerData;
  createdAt?: string; // ISO 8601 string
}

interface ComposerData {
  composerId: string;
  name?: string;
  fullConversationHeadersOnly?: BubbleHeader[];
  status?: string;
  createdAt?: number; // unix ms
  lastUpdatedAt?: number;
}

// ---------------------------------------------------------------------------
// DB path resolution
// ---------------------------------------------------------------------------

export function resolveCursorDbPath(): string {
  switch (process.platform) {
    case "darwin":
      return path.join(
        os.homedir(),
        "Library",
        "Application Support",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      );
    case "linux":
      return path.join(
        os.homedir(),
        ".config",
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      );
    case "win32":
      return path.join(
        process.env.APPDATA ?? os.homedir(),
        "Cursor",
        "User",
        "globalStorage",
        "state.vscdb",
      );
    default:
      throw new Error(`Unsupported platform for Cursor: ${process.platform}`);
  }
}

// ---------------------------------------------------------------------------
// Cursor DB reader
// ---------------------------------------------------------------------------

/**
 * Opens the Cursor state.vscdb in read-only mode and returns a wrapper.
 * The caller must call close() when done.
 */
export function openCursorDb(dbPath?: string): Database.Database {
  const resolved = dbPath ?? resolveCursorDbPath();
  // Open read-only — we never write to Cursor's DB
  return new Database(resolved, { readonly: true, fileMustExist: true });
}

/**
 * Reads composer metadata for a given composerId.
 */
export function getComposerData(
  db: Database.Database,
  composerId: string,
): ComposerData | null {
  const row = db
    .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
    .get(`composerData:${composerId}`) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as ComposerData;
  } catch {
    return null;
  }
}

/**
 * Reads a single bubble by composerId + bubbleId.
 */
function getBubble(
  db: Database.Database,
  composerId: string,
  bubbleId: string,
): CursorBubble | null {
  const row = db
    .prepare("SELECT value FROM cursorDiskKV WHERE key = ?")
    .get(`bubbleId:${composerId}:${bubbleId}`) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as CursorBubble;
  } catch {
    return null;
  }
}

/**
 * Lists all composerIds in the DB, ordered by most-recently-updated first.
 * Used by the incremental indexer to find new/updated sessions.
 */
export function listComposerIds(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' ORDER BY rowid DESC",
    )
    .all() as Array<{ key: string; value: string }>;

  return rows.map((r) => r.key.replace("composerData:", ""));
}

// ---------------------------------------------------------------------------
// Bubble → FullMessage conversion
// ---------------------------------------------------------------------------

function convertUserBubble(bubble: CursorBubble): FullMessage | null {
  const text = (bubble.text ?? "").trim();
  if (!text) return null;

  return {
    info: {
      id: bubble.bubbleId,
      role: "user",
      time: bubble.createdAt
        ? { created: new Date(bubble.createdAt).getTime() }
        : {},
    },
    parts: [{ type: "text", text }],
  };
}

function convertAiBubble(bubble: CursorBubble): FullMessage | null {
  // Skip thinking bubbles
  if (bubble.isThought) return null;

  const parts: MessagePart[] = [];
  const tf = bubble.toolFormerData;

  if (tf?.name) {
    // Tool call bubble
    let args: unknown;
    try {
      args = tf.rawArgs ? JSON.parse(tf.rawArgs) : undefined;
    } catch {
      args = tf.rawArgs;
    }

    let result: unknown;
    try {
      result = tf.result ? JSON.parse(tf.result) : undefined;
    } catch {
      result = tf.result;
    }

    // Extract a readable result string
    let resultText: string | undefined;
    if (result !== undefined) {
      if (typeof result === "string") {
        resultText = result;
      } else if (
        result &&
        typeof result === "object" &&
        "contents" in result &&
        typeof (result as Record<string, unknown>).contents === "string"
      ) {
        resultText = (result as Record<string, unknown>).contents as string;
      } else {
        resultText = JSON.stringify(result, null, 2);
      }
    }

    const state = tf.status === "completed" ? "result" : "call";

    parts.push({
      type: "tool-invocation",
      toolName: tf.name,
      toolCallId: tf.toolCallId ?? bubble.bubbleId,
      state,
      args,
      result: state === "result" ? (resultText ?? "(no output)") : undefined,
    });
  } else {
    // Text bubble
    const text = (bubble.text ?? "").trim();
    if (!text) return null;
    parts.push({ type: "text", text });
  }

  if (parts.length === 0) return null;

  return {
    info: {
      id: bubble.bubbleId,
      role: "assistant",
      time: bubble.createdAt
        ? { created: new Date(bubble.createdAt).getTime() }
        : {},
    },
    parts,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Reads all messages for a Cursor conversation from the DB and converts them
 * to FullMessage[]. Preserves the order defined by fullConversationHeadersOnly.
 *
 * @param db          Open Cursor state.vscdb connection
 * @param composerId  The conversation ID (same as conversation_id in hook payload)
 */
export function cursorSessionToMessages(
  db: Database.Database,
  composerId: string,
): FullMessage[] {
  const composer = getComposerData(db, composerId);
  if (!composer) return [];

  const headers = composer.fullConversationHeadersOnly ?? [];
  const messages: FullMessage[] = [];

  for (const header of headers) {
    const bubble = getBubble(db, composerId, header.bubbleId);
    if (!bubble) continue;

    let msg: FullMessage | null = null;
    if (bubble.type === 1) {
      msg = convertUserBubble(bubble);
    } else if (bubble.type === 2) {
      msg = convertAiBubble(bubble);
    }

    if (msg) messages.push(msg);
  }

  return messages;
}

/**
 * Derives a session title from the first user message text.
 */
export function deriveCursorSessionTitle(
  composer: ComposerData,
  messages: FullMessage[],
): string {
  // Use the composer name if it was set by Cursor
  if (composer.name && composer.name.trim()) {
    return composer.name.trim().slice(0, 80);
  }
  // Fall back to first user message text
  for (const msg of messages) {
    if (msg.info.role !== "user") continue;
    for (const part of msg.parts) {
      if (part.type === "text" && part.text) {
        return part.text.replace(/\s+/g, " ").trim().slice(0, 80);
      }
    }
  }
  return "Cursor Session";
}
