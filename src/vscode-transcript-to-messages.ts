/**
 * Parses a VS Code (Copilot agent) JSONL transcript into the FullMessage[]
 * format used by the indexer.
 *
 * VS Code writes transcripts to:
 *   <workspaceStorage>/<hash>/GitHub.copilot-chat/transcripts/<sessionId>.jsonl
 *
 * The transcript is an ordered event stream. Each line is a JSON object with:
 *   - `type`: event type string
 *   - `data`: event-specific payload
 *   - `id`: unique event UUID
 *   - `timestamp`: ISO 8601 timestamp
 *   - `parentId`: UUID of the parent event (forms a tree)
 *
 * Known event types:
 *   - `session.start`           — session metadata (first line)
 *   - `user.message`            — user turn: { content: string, attachments: [] }
 *   - `assistant.turn_start`    — marks the start of an assistant turn
 *   - `assistant.message`       — assistant text: { messageId, content, toolRequests, reasoningText? }
 *   - `tool.execution_start`    — tool call: { toolCallId, toolName, arguments }
 *   - `tool.execution_complete` — tool result: { toolCallId, result, success }
 *   - `assistant.turn_end`      — marks the end of an assistant turn
 */

import fs from "fs";
import type { FullMessage, MessagePart } from "./types";

// ---------------------------------------------------------------------------
// Raw transcript event shapes
// ---------------------------------------------------------------------------

interface TranscriptEvent {
  type: string;
  data: Record<string, unknown>;
  id: string;
  timestamp: string;
  parentId: string | null;
}

interface UserMessageData {
  content: string;
  attachments?: unknown[];
}

interface AssistantMessageData {
  messageId: string;
  content: string;
  toolRequests?: Array<{ toolCallId: string; toolName: string; arguments?: unknown }>;
  reasoningText?: string;
}

interface ToolExecutionStartData {
  toolCallId: string;
  toolName: string;
  arguments?: unknown;
}

interface ToolExecutionCompleteData {
  toolCallId: string;
  result?: unknown;
  success: boolean;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parses a VS Code JSONL transcript file into FullMessage[].
 *
 * Produces one FullMessage per logical turn:
 *   - user.message → role "user" with text part
 *   - assistant.message + associated tool calls → role "assistant" with
 *     text part and tool-invocation parts
 *   - tool.execution_complete → added as tool-invocation result to the
 *     preceding assistant message (if matched) or as a standalone tool message
 */
export function parseVscodeTranscript(transcriptPath: string): FullMessage[] {
  const raw = fs.readFileSync(transcriptPath, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim());

  const events: TranscriptEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line) as TranscriptEvent);
    } catch {
      continue;
    }
  }

  // Index tool results by toolCallId for pairing with tool calls
  const toolResults = new Map<string, ToolExecutionCompleteData>();
  for (const ev of events) {
    if (ev.type === "tool.execution_complete") {
      const d = ev.data as unknown as ToolExecutionCompleteData;
      if (d.toolCallId) {
        toolResults.set(d.toolCallId, d);
      }
    }
  }

  const messages: FullMessage[] = [];

  for (const ev of events) {
    switch (ev.type) {
      case "user.message": {
        const d = ev.data as unknown as UserMessageData;
        const text = d.content?.trim();
        if (!text) break;
        messages.push({
          info: {
            id: ev.id,
            role: "user",
            time: { created: new Date(ev.timestamp).getTime() },
          },
          parts: [{ type: "text", text }],
        });
        break;
      }

      case "assistant.message": {
        const d = ev.data as unknown as AssistantMessageData;
        const parts: MessagePart[] = [];

        if (d.content?.trim()) {
          parts.push({ type: "text", text: d.content.trim() });
        }

        // Attach tool calls as tool-invocation parts
        if (Array.isArray(d.toolRequests)) {
          for (const req of d.toolRequests) {
            const result = toolResults.get(req.toolCallId);
            parts.push({
              type: "tool-invocation",
              toolName: req.toolName ?? "unknown",
              toolCallId: req.toolCallId,
              state: result ? "result" : "call",
              args: req.arguments,
              ...(result ? { result: formatToolResult(result.result) } : {}),
            });
          }
        }

        if (parts.length === 0) break;

        messages.push({
          info: {
            id: ev.id,
            role: "assistant",
            time: { created: new Date(ev.timestamp).getTime() },
          },
          parts,
        });
        break;
      }

      // tool.execution_start without a corresponding assistant.message
      // (unlikely in practice, but handle gracefully)
      case "tool.execution_start": {
        const d = ev.data as unknown as ToolExecutionStartData;
        // Only emit standalone tool-call messages if there's no assistant.message
        // that claims this toolCallId via toolRequests — we handle the common
        // case in the assistant.message branch above.
        // Standalone entries are skipped here to avoid duplication.
        void d;
        break;
      }

      default:
        break;
    }
  }

  return messages;
}

function formatToolResult(result: unknown): string {
  if (result === undefined || result === null) return "(no output)";
  if (typeof result === "string") return result;
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

// ---------------------------------------------------------------------------
// Session title
// ---------------------------------------------------------------------------

/**
 * Derives a session title from the transcript messages.
 * Uses the first meaningful user message text, truncated to 60 chars.
 */
export function deriveVscodeSessionTitle(messages: FullMessage[]): string {
  for (const msg of messages) {
    if (msg.info.role !== "user") continue;
    for (const part of msg.parts) {
      if (part.type === "text" && part.text) {
        const title = part.text.replace(/\s+/g, " ").trim().slice(0, 60);
        if (title) return title;
      }
    }
  }
  return "VS Code Session";
}
