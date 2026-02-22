/**
 * Parses a Codex (OpenAI CLI) JSONL session file into FullMessage[].
 *
 * Codex sessions are stored at:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl
 *
 * Each line is: { timestamp, type, payload }
 *
 * Indexed:
 *   - event_msg.user_message
 *   - response_item.message where role=assistant and phase=final_answer
 *   - response_item.function_call paired with function_call_output by call_id
 *
 * Skipped:
 *   - response_item role=user/developer injections
 *   - assistant commentary phase
 *   - reasoning items and other metadata lines
 */

import fs from "fs";
import type { FullMessage, MessagePart } from "./types";

interface CodexLine {
  timestamp: string;
  type: string;
  payload: unknown;
}

interface EventMsgPayload {
  type?: string;
  message?: string;
  turn_id?: string;
}

interface FunctionCallPayload {
  type: "function_call";
  name?: string;
  arguments?: string;
  call_id?: string;
}

interface FunctionCallOutputPayload {
  type: "function_call_output";
  call_id?: string;
  output?: unknown;
}

interface AssistantMessagePayload {
  type: "message";
  role?: string;
  phase?: string;
  content?: Array<{ type?: string; text?: string }>;
}

function toTimestampMs(value: string): number {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Date.now() : ms;
}

function outputToString(output: unknown): string {
  if (output === undefined || output === null) return "(no output)";
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

export function codexSessionToMessages(filePath: string): FullMessage[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim());

  const parsed: CodexLine[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as CodexLine);
    } catch {
      continue;
    }
  }

  const toolResults = new Map<string, string>();
  for (const line of parsed) {
    if (line.type !== "response_item") continue;
    const payload = line.payload as FunctionCallOutputPayload;
    if (payload.type !== "function_call_output" || !payload.call_id) continue;
    toolResults.set(payload.call_id, outputToString(payload.output));
  }

  const messages: FullMessage[] = [];
  let currentTurnId = "turn-0";
  let currentTurnStartLineIndex = 0;
  const pendingToolCalls: FunctionCallPayload[] = [];
  let pendingFinalAnswerText = "";
  let pendingCommentaryText = "";
  let pendingAgentMessageText = "";

  function flushAssistantMessage(timestamp: string, lineIndex: number): void {
    const assistantText =
      pendingFinalAnswerText ||
      pendingAgentMessageText ||
      pendingCommentaryText;

    const parts: MessagePart[] = [];

    for (const toolCall of pendingToolCalls) {
      let parsedArgs: unknown = toolCall.arguments;
      if (typeof toolCall.arguments === "string") {
        try {
          parsedArgs = JSON.parse(toolCall.arguments);
        } catch {
          parsedArgs = toolCall.arguments;
        }
      }

      const result = toolResults.get(toolCall.call_id ?? "");
      parts.push({
        type: "tool-invocation",
        toolName: toolCall.name,
        toolCallId: toolCall.call_id,
        state: result !== undefined ? "result" : "call",
        args: parsedArgs,
        ...(result !== undefined ? { result } : {}),
      });
    }

    // Keep assistant text last so session print ends with the final answer
    // instead of trailing tool output for that turn.
    if (assistantText.trim()) {
      parts.push({ type: "text", text: assistantText.trim() });
    }

    if (parts.length > 0) {
      messages.push({
        info: {
          id: `${currentTurnId}-assistant-${lineIndex}`,
          role: "assistant",
          time: { created: toTimestampMs(timestamp) },
        },
        parts,
      });
    }

    pendingToolCalls.length = 0;
    pendingFinalAnswerText = "";
    pendingCommentaryText = "";
    pendingAgentMessageText = "";
  }

  for (let i = 0; i < parsed.length; i++) {
    const line = parsed[i];
    const lineIndex = i + 1;

    if (line.type === "event_msg") {
      const payload = line.payload as EventMsgPayload;

      if (payload.type === "task_started") {
        if (pendingToolCalls.length > 0 || pendingFinalAnswerText || pendingCommentaryText || pendingAgentMessageText) {
          flushAssistantMessage(line.timestamp, currentTurnStartLineIndex || lineIndex);
        }
        if (typeof payload.turn_id === "string" && payload.turn_id.trim()) {
          currentTurnId = payload.turn_id;
        }
        currentTurnStartLineIndex = lineIndex;
        continue;
      }

      if (payload.type === "user_message") {
        const text = payload.message?.trim();
        if (!text) continue;
        messages.push({
          info: {
            id: `${currentTurnId}-user-${lineIndex}`,
            role: "user",
            time: { created: toTimestampMs(line.timestamp) },
          },
          parts: [{ type: "text", text }],
        });
      }

      if (payload.type === "agent_message") {
        const text = payload.message?.trim();
        if (text) pendingAgentMessageText = text;
      }

      if (payload.type === "task_complete") {
        flushAssistantMessage(line.timestamp, lineIndex);
      }

      continue;
    }

    if (line.type !== "response_item") continue;

    const payload = line.payload as FunctionCallPayload | FunctionCallOutputPayload | AssistantMessagePayload;

    if (payload.type === "function_call") {
      if (payload.name && payload.call_id) {
        pendingToolCalls.push(payload as FunctionCallPayload);
      }
      continue;
    }

    if (payload.type === "function_call_output") {
      continue;
    }

    if (payload.type !== "message") continue;

    const assistantMessage = payload as AssistantMessagePayload;
    if (assistantMessage.role !== "assistant") continue;
    if (assistantMessage.phase !== "final_answer" && assistantMessage.phase !== "commentary") continue;

    const blocks: string[] = [];
    for (const block of assistantMessage.content ?? []) {
      if (block.type === "output_text" && block.text?.trim()) {
        blocks.push(block.text.trim());
      }
    }
    const text = blocks.join("\n").trim();
    if (!text) continue;
    if (assistantMessage.phase === "final_answer") {
      pendingFinalAnswerText = text;
    } else {
      pendingCommentaryText = text;
    }
  }

  // Flush a dangling turn at EOF (defensive for interrupted runs).
  if (pendingToolCalls.length > 0 || pendingFinalAnswerText || pendingCommentaryText || pendingAgentMessageText) {
    const lastTs = parsed[parsed.length - 1]?.timestamp ?? new Date().toISOString();
    const lineIndex = parsed.length || 1;
    flushAssistantMessage(lastTs, lineIndex);
  }

  return messages;
}

export function deriveCodexSessionTitle(
  messages: FullMessage[],
  lastAssistantMessage?: string,
): string {
  for (const msg of messages) {
    if (msg.info.role !== "user") continue;
    for (const part of msg.parts) {
      if (part.type !== "text" || !part.text) continue;
      const title = part.text.replace(/\s+/g, " ").trim().slice(0, 60);
      if (title) return title;
    }
  }

  const assistantTitle = (lastAssistantMessage ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
  return assistantTitle || "Codex Session";
}
