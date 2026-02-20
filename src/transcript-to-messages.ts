/**
 * Parses a Claude Code JSONL transcript into the FullMessage[] format used
 * by the indexer.
 *
 * Transcript format observations:
 * - Each line is a JSON object with a `type` field
 * - `type: "file-history-snapshot"` — internal snapshot, skip
 * - `type: "user"` with `isMeta: true` — local command caveat, skip
 * - `type: "user"` with array `content` of `tool_result` — tool output, keep
 * - `type: "user"` with string `content` — regular user message, keep
 *   (but skip /command messages and login stdout noise)
 * - `type: "assistant"` — may appear multiple times with the same `message.id`
 *   (streaming chunks); we keep the LAST entry per message.id
 * - `isApiErrorMessage: true` — skip
 * - Assistant `content` blocks of type "thinking" — skip (internal reasoning)
 * - Assistant `content` blocks of type "tool_use" — keep (tool call)
 * - User `content` array with `tool_result` — keep (tool output)
 */

import fs from "fs";
import type { FullMessage, MessagePart } from "./types";

// ---------------------------------------------------------------------------
// Raw transcript line shapes
// ---------------------------------------------------------------------------

interface TranscriptUserLine {
  type: "user";
  uuid: string;
  timestamp: string;
  sessionId: string;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  message: {
    role: "user";
    content: string | TranscriptToolResult[];
  };
  toolUseResult?: {
    stdout?: string;
    stderr?: string;
  };
  sourceToolAssistantUUID?: string;
}

interface TranscriptToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

interface TranscriptAssistantLine {
  type: "assistant";
  uuid: string;
  timestamp: string;
  sessionId: string;
  isApiErrorMessage?: boolean;
  message: {
    id: string;
    role: "assistant";
    model?: string;
    content: TranscriptContentBlock[];
    stop_reason?: string | null;
  };
  requestId?: string;
}

interface TranscriptContentBlock {
  type: "text" | "thinking" | "tool_use";
  // text
  text?: string;
  // thinking
  thinking?: string;
  signature?: string;
  // tool_use
  id?: string;
  name?: string;
  input?: unknown;
}

type TranscriptLine =
  | TranscriptUserLine
  | TranscriptAssistantLine
  | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

function convertUserMessage(line: TranscriptUserLine): FullMessage | null {
  const content = line.message.content;

  // Skip meta messages (local command caveats, /login stdout, etc.)
  if (line.isMeta) return null;

  // Skip API error messages
  if (line.isApiErrorMessage) return null;

  const parts: MessagePart[] = [];

  if (typeof content === "string") {
    const text = content.trim();
    // Skip empty, slash-commands, and local-command XML noise
    if (!text) return null;
    if (text.startsWith("<local-command") || text.startsWith("<command-name>")) return null;
    parts.push({ type: "text", text });
  } else if (Array.isArray(content)) {
    // Tool results
    for (const block of content) {
      if (block.type === "tool_result") {
        const resultText = typeof block.content === "string" ? block.content : "";
        parts.push({
          type: "tool-invocation",
          toolName: "tool_result",
          toolCallId: block.tool_use_id,
          state: "result",
          result: resultText || (block.is_error ? "(error)" : "(no output)"),
        });
      }
    }
  }

  if (parts.length === 0) return null;

  return {
    info: {
      id: line.uuid,
      role: "user",
      time: { created: new Date(line.timestamp).getTime() },
    },
    parts,
  };
}

function convertAssistantMessage(line: TranscriptAssistantLine): FullMessage | null {
  if (line.isApiErrorMessage) return null;

  const parts: MessagePart[] = [];

  for (const block of line.message.content) {
    switch (block.type) {
      case "text":
        if (block.text?.trim()) {
          parts.push({ type: "text", text: block.text.trim() });
        }
        break;

      case "tool_use":
        parts.push({
          type: "tool-invocation",
          toolName: block.name ?? "unknown",
          toolCallId: block.id,
          state: "call",
          args: block.input,
        });
        break;

      case "thinking":
        // Skip internal reasoning — not useful to index
        break;
    }
  }

  if (parts.length === 0) return null;

  return {
    info: {
      id: line.uuid,
      role: "assistant",
      modelID: line.message.model,
      time: { created: new Date(line.timestamp).getTime() },
    },
    parts,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parses a Claude Code JSONL transcript file into FullMessage[].
 *
 * Deduplicates streaming assistant chunks (same message.id → keep last),
 * and pairs tool_use calls with their tool_result responses.
 */
export function parseTranscript(transcriptPath: string): FullMessage[] {
  const raw = fs.readFileSync(transcriptPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());

  // First pass: collect all lines, deduplicate assistant messages by message.id
  // (streaming sends partial chunks — we want only the final complete message)
  const assistantByMsgId = new Map<string, TranscriptAssistantLine>();
  const orderedEntries: Array<{ uuid: string; line: TranscriptLine }> = [];
  const seenUuids = new Set<string>();

  for (const raw of lines) {
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }

    if (line.type === "file-history-snapshot") continue;

    if (line.type === "assistant") {
      const al = line as TranscriptAssistantLine;
      const msgId = al.message?.id;
      if (msgId) {
        // Always overwrite — last chunk wins (most complete content)
        assistantByMsgId.set(msgId, al);
        // Track insertion order by uuid (first occurrence)
        if (!seenUuids.has(al.uuid)) {
          seenUuids.add(al.uuid);
          orderedEntries.push({ uuid: al.uuid, line });
        }
      }
      continue;
    }

    if (line.type === "user" || line.type === "system") {
      const ul = line as TranscriptUserLine;
      if (!seenUuids.has(ul.uuid)) {
        seenUuids.add(ul.uuid);
        orderedEntries.push({ uuid: ul.uuid, line });
      }
    }
  }

  // Second pass: resolve assistant lines to their final (deduplicated) version
  // and pair tool_use with tool_result
  const messages: FullMessage[] = [];

  // Build a map: tool_use_id → tool result text (from user tool_result messages)
  const toolResults = new Map<string, string>();
  for (const { line } of orderedEntries) {
    if (line.type !== "user") continue;
    const ul = line as TranscriptUserLine;
    if (Array.isArray(ul.message.content)) {
      for (const block of ul.message.content as TranscriptToolResult[]) {
        if (block.type === "tool_result") {
          toolResults.set(block.tool_use_id, block.content ?? "");
        }
      }
    }
  }

  for (const { line } of orderedEntries) {
    if (line.type === "assistant") {
      const al = line as TranscriptAssistantLine;
      const msgId = al.message?.id;
      // Use the final (deduplicated) version
      const finalLine = msgId ? (assistantByMsgId.get(msgId) ?? al) : al;

      // Enrich tool_use blocks with their results
      const enriched: TranscriptAssistantLine = {
        ...finalLine,
        message: {
          ...finalLine.message,
          content: finalLine.message.content.map((block) => {
            if (block.type === "tool_use" && block.id && toolResults.has(block.id)) {
              // We'll render the result separately via tool_result user messages
              // Just keep the call here
            }
            return block;
          }),
        },
      };

      const msg = convertAssistantMessage(enriched);
      if (msg) messages.push(msg);
    } else if (line.type === "user") {
      const ul = line as TranscriptUserLine;
      // Skip tool_result-only messages (already captured in assistant context)
      // but DO include them so the indexer can see what tools returned
      const msg = convertUserMessage(ul);
      if (msg) messages.push(msg);
    }
  }

  return messages;
}

/**
 * Derives a session title from the transcript messages.
 * Uses the first meaningful user message text, truncated to 60 chars.
 */
export function deriveSessionTitle(messages: FullMessage[]): string {
  for (const msg of messages) {
    if (msg.info.role !== "user") continue;
    for (const part of msg.parts) {
      if (part.type === "text" && part.text) {
        const title = part.text.replace(/\s+/g, " ").trim().slice(0, 60);
        if (title) return title;
      }
    }
  }
  return "Claude Code Session";
}
