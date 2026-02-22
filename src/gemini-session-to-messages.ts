/**
 * Parses a Gemini CLI session transcript JSON file into FullMessage[].
 *
 * Expected top-level shape (best-effort):
 *   {
 *     session_id?: string,
 *     messages: [
 *       {
 *         id?: string,
 *         type: "user" | "gemini" | ...,
 *         timestamp?: string | number,
 *         content?: unknown,
 *         toolCalls?: unknown[]
 *       }
 *     ]
 *   }
 *
 * Indexed message types:
 *   - type === "user"
 *   - type === "gemini"
 */

import fs from "fs";
import type { FullMessage, MessagePart } from "./types";

interface GeminiSession {
  session_id?: string;
  sessionId?: string;
  messages?: GeminiMessage[];
}

interface GeminiMessage {
  id?: string;
  type?: string;
  timestamp?: string | number;
  created_at?: string | number;
  time?: string | number;
  content?: unknown;
  text?: unknown;
  toolCalls?: unknown;
}

interface GeminiToolCall {
  id?: string;
  callId?: string;
  toolCallId?: string;
  name?: string;
  toolName?: string;
  functionName?: string;
  tool?: string;
  args?: unknown;
  arguments?: unknown;
  input?: unknown;
  parameters?: unknown;
  result?: unknown;
  output?: unknown;
  response?: unknown;
  error?: unknown;
  status?: string;
  state?: string;
}

function parseTimestampMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.now();
}

function toStringSafe(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractTextFromContent(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  if (Array.isArray(value)) {
    const pieces = value
      .map((v) => extractTextFromContent(v))
      .filter((v) => v.trim().length > 0);
    return pieces.join("\n").trim();
  }

  if (typeof value !== "object") return "";

  const obj = value as Record<string, unknown>;

  // Most common block shape: { type: "text", text: "..." }
  if (typeof obj.text === "string" && obj.text.trim()) {
    return obj.text.trim();
  }

  // Common nested containers used by model message formats
  const nestedKeys = ["content", "parts", "chunks", "segment", "message"];
  for (const key of nestedKeys) {
    if (key in obj) {
      const text = extractTextFromContent(obj[key]);
      if (text) return text;
    }
  }

  return "";
}

function normalizeToolState(status: unknown, hasResult: boolean): "call" | "result" {
  const normalized = typeof status === "string"
    ? status.trim().toLowerCase()
    : "";

  if (
    normalized === "result" ||
    normalized === "complete" ||
    normalized === "completed" ||
    normalized === "success" ||
    normalized === "ok" ||
    normalized === "done" ||
    normalized === "error" ||
    normalized === "failed"
  ) {
    return "result";
  }

  if (
    normalized === "call" ||
    normalized === "pending" ||
    normalized === "running" ||
    normalized === "in_progress"
  ) {
    return "call";
  }

  return hasResult ? "result" : "call";
}

function toolCallToPart(rawCall: unknown, messageIndex: number, toolIndex: number): MessagePart | null {
  if (!rawCall || typeof rawCall !== "object") return null;
  const call = rawCall as GeminiToolCall;

  const toolName = call.name ?? call.toolName ?? call.functionName ?? call.tool ?? "unknown";
  const toolCallId = call.id ?? call.callId ?? call.toolCallId ?? `tool-${messageIndex}-${toolIndex}`;
  const args = call.args ?? call.arguments ?? call.input ?? call.parameters;
  const result = call.result ?? call.output ?? call.response ?? call.error;
  const hasResult = result !== undefined;
  const state = normalizeToolState(call.status ?? call.state, hasResult);

  const part: MessagePart = {
    type: "tool-invocation",
    toolName,
    toolCallId,
    state,
  };

  if (args !== undefined) part.args = args;
  if (state === "result" && result !== undefined) {
    part.result = typeof result === "string" ? result : toStringSafe(result);
  }

  if (state === "result" && result === undefined && (call.status === "error" || call.state === "error")) {
    part.result = "(error)";
  }

  return part;
}

export function geminiSessionToMessages(transcriptPath: string): FullMessage[] {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }

  let session: GeminiSession;
  try {
    session = JSON.parse(raw) as GeminiSession;
  } catch {
    return [];
  }

  const entries = Array.isArray(session.messages) ? session.messages : [];
  const messages: FullMessage[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry || typeof entry !== "object") continue;

    const type = (entry.type ?? "").toLowerCase();
    if (type !== "user" && type !== "gemini") continue;

    const parts: MessagePart[] = [];

    const text = extractTextFromContent(entry.content ?? entry.text);
    if (text.trim()) {
      parts.push({ type: "text", text: text.trim() });
    }

    if (Array.isArray(entry.toolCalls)) {
      for (let j = 0; j < entry.toolCalls.length; j++) {
        const toolPart = toolCallToPart(entry.toolCalls[j], i, j);
        if (toolPart) parts.push(toolPart);
      }
    }

    if (parts.length === 0) continue;

    const role = type === "user" ? "user" : "assistant";
    const sessionKey = session.session_id ?? session.sessionId ?? "gemini-session";
    const fallbackId = `${sessionKey}-${i}`;
    const msgId = typeof entry.id === "string" && entry.id.trim() ? entry.id : fallbackId;

    messages.push({
      info: {
        id: msgId,
        role,
        time: {
          created: parseTimestampMs(entry.timestamp ?? entry.created_at ?? entry.time),
        },
      },
      parts,
    });
  }

  return messages;
}

export function deriveGeminiSessionTitle(
  messages: FullMessage[],
  fallbackSessionId?: string,
): string {
  for (const msg of messages) {
    if (msg.info.role !== "user") continue;
    for (const part of msg.parts) {
      if (part.type !== "text" || !part.text) continue;
      const title = part.text.replace(/\s+/g, " ").trim().slice(0, 60);
      if (title) return title;
    }
  }

  if (fallbackSessionId?.trim()) return fallbackSessionId.trim();
  return "Gemini CLI Session";
}
