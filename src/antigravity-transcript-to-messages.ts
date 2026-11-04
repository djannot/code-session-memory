/**
 * Parses an Antigravity 2.x transcript (JSONL) into FullMessage[].
 *
 * Antigravity writes one JSON object per line, one per trajectory step. The
 * hook payload hands us the path (`transcriptPath`); on disk it lives at
 * `~/.gemini/<surface>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`
 * where `<surface>` is `antigravity`, `antigravity-ide` or `antigravity-cli`.
 *
 * Step shape (fields present depend on the step type):
 *   {
 *     step_index: number,
 *     source: "USER_EXPLICIT" | "MODEL" | "SYSTEM",
 *     type: "USER_INPUT" | "PLANNER_RESPONSE" | "GENERIC" | "SYSTEM_MESSAGE",
 *     status: "DONE" | ...,
 *     created_at: "2026-11-04T11:09:57Z",
 *     content?: string,
 *     thinking?: string,
 *     tool_calls?: [{ name: string, args: Record<string, unknown> }],
 *     error?: string,
 *     input_tokens?: number,
 *     cache_read_tokens?: number,
 *     output_tokens?: number,
 *     truncated_fields?: string[]
 *   }
 *
 * Indexing rules:
 *   - `USER_INPUT` becomes a user message. Antigravity wraps the prompt in
 *     `<USER_REQUEST>` and appends `<ADDITIONAL_METADATA>` /
 *     `<USER_SETTINGS_CHANGE>` blocks the user never typed — we keep only the
 *     request itself.
 *   - `PLANNER_RESPONSE` becomes an assistant message. `thinking` is internal
 *     reasoning and is skipped, matching the Claude Code parser.
 *   - `GENERIC` steps carry tool *results*: a PLANNER_RESPONSE emitting N tool
 *     calls is followed by N GENERIC steps, in order. They are merged back into
 *     the matching `tool-invocation` part so each tool call is a single message
 *     with both Input and Output (same shape as the Cursor, Codex and Gemini CLI
 *     parsers).
 *   - `SYSTEM_MESSAGE` is platform noise and is skipped.
 */

import fs from "fs";
import type { FullMessage, MessagePart, MessageTokens } from "./types";

interface AntigravityToolCall {
  name?: string;
  args?: unknown;
}

interface AntigravityStep {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  created_at?: string;
  content?: unknown;
  thinking?: unknown;
  tool_calls?: unknown;
  error?: unknown;
  input_tokens?: number;
  cache_read_tokens?: number;
  output_tokens?: number;
}

export interface AntigravityParseOptions {
  /** Conversation id, used to build stable message ids. */
  conversationId?: string;
  /** Model reported by the hook payload (`modelName`), recorded for analytics. */
  modelName?: string;
}

const USER_STEP_TYPES = new Set(["USER_INPUT"]);
const ASSISTANT_STEP_TYPES = new Set(["PLANNER_RESPONSE"]);
const TOOL_RESULT_STEP_TYPES = new Set(["GENERIC"]);

/**
 * Pulls the text the user actually typed out of Antigravity's wrapper tags.
 * Falls back to the raw content with the known metadata blocks removed.
 */
export function extractUserRequest(raw: unknown): string {
  if (typeof raw !== "string") return "";

  const match = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(raw);
  if (match) return match[1].trim();

  return raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/g, "")
    .trim();
}

function parseTimestampMs(value: unknown, fallback: number): number {
  if (typeof value === "string") {
    const ms = Date.parse(value);
    if (!Number.isNaN(ms)) return ms;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return fallback;
}

function toText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  return "";
}

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : 0;
}

/**
 * Antigravity reports `input_tokens` and `cache_read_tokens` as disjoint counts
 * (the input figure excludes what was served from cache), so they map straight
 * onto the shared MessageTokens shape without subtraction.
 */
function stepTokens(step: AntigravityStep): MessageTokens | undefined {
  const input = positiveInt(step.input_tokens);
  const cacheRead = positiveInt(step.cache_read_tokens);
  const output = positiveInt(step.output_tokens);
  if (input === 0 && cacheRead === 0 && output === 0) return undefined;

  return {
    input,
    output,
    total: input + cacheRead + output,
    cache: { read: cacheRead, write: 0 },
  };
}

function readSteps(transcriptPath: string): AntigravityStep[] {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }

  const steps: AntigravityStep[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        steps.push(parsed as AntigravityStep);
      }
    } catch {
      // A partially flushed last line is normal while a turn is still running.
    }
  }

  // Steps are written in order, but a stable sort on step_index keeps the
  // tool-call/result pairing correct even if a line is written out of order.
  return steps
    .map((step, i) => ({ step, i }))
    .sort((a, b) => {
      const ai = typeof a.step.step_index === "number" ? a.step.step_index : a.i;
      const bi = typeof b.step.step_index === "number" ? b.step.step_index : b.i;
      return ai === bi ? a.i - b.i : ai - bi;
    })
    .map(({ step }) => step);
}

function toolResultFromStep(step: AntigravityStep): { text: string; failed: boolean } {
  const error = toText(step.error);
  const content = toText(step.content);
  if (error && content) return { text: `${content}\n(error: ${error})`, failed: true };
  if (error) return { text: `(error: ${error})`, failed: true };
  return { text: content, failed: false };
}

export function antigravityTranscriptToMessages(
  transcriptPath: string,
  options: AntigravityParseOptions = {},
): FullMessage[] {
  const steps = readSteps(transcriptPath);
  if (steps.length === 0) return [];

  const sessionKey = options.conversationId?.trim() || "antigravity-session";
  const modelName = options.modelName?.trim();
  const messages: FullMessage[] = [];
  const now = Date.now();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const type = typeof step.type === "string" ? step.type.toUpperCase() : "";
    const stepIndex = typeof step.step_index === "number" ? step.step_index : i;
    const created = parseTimestampMs(step.created_at, now);

    if (USER_STEP_TYPES.has(type)) {
      const text = extractUserRequest(step.content);
      if (!text) continue;
      messages.push({
        info: {
          id: `${sessionKey}-${stepIndex}`,
          role: "user",
          time: { created },
        },
        parts: [{ type: "text", text }],
      });
      continue;
    }

    if (!ASSISTANT_STEP_TYPES.has(type)) {
      // GENERIC steps are consumed below as tool results; SYSTEM_MESSAGE and
      // anything unknown is platform noise.
      continue;
    }

    const parts: MessagePart[] = [];

    const text = toText(step.content);
    if (text) parts.push({ type: "text", text });

    const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];

    // The N GENERIC steps that directly follow hold this step's N results.
    let cursor = i + 1;
    for (let t = 0; t < toolCalls.length; t++) {
      const rawCall = toolCalls[t];
      const call: AntigravityToolCall =
        rawCall && typeof rawCall === "object" ? (rawCall as AntigravityToolCall) : {};

      const part: MessagePart = {
        type: "tool-invocation",
        toolName: toText(call.name) || "unknown",
        toolCallId: `${sessionKey}-${stepIndex}-${t}`,
        state: "call",
      };
      if (call.args !== undefined) part.args = call.args;

      const resultStep = steps[cursor];
      const resultType =
        resultStep && typeof resultStep.type === "string"
          ? resultStep.type.toUpperCase()
          : "";
      if (resultStep && TOOL_RESULT_STEP_TYPES.has(resultType)) {
        const { text: result, failed } = toolResultFromStep(resultStep);
        if (result) {
          // Antigravity is the only source that reports tool failures as their
          // own field, so the error state here is real rather than inferred.
          part.state = failed ? "error" : "result";
          part.result = result;
        }
        cursor++;
      }

      parts.push(part);
    }

    if (parts.length === 0) continue;

    const tokens = stepTokens(step);
    messages.push({
      info: {
        id: `${sessionKey}-${stepIndex}`,
        role: "assistant",
        time: { created },
        ...(modelName ? { modelID: modelName } : {}),
        ...(tokens ? { tokens } : {}),
      },
      parts,
    });
  }

  return messages;
}

export function deriveAntigravitySessionTitle(
  messages: FullMessage[],
  fallbackConversationId?: string,
): string {
  for (const msg of messages) {
    if (msg.info.role !== "user") continue;
    for (const part of msg.parts) {
      if (part.type !== "text" || !part.text) continue;
      const title = part.text.replace(/\s+/g, " ").trim().slice(0, 60);
      if (title) return title;
    }
  }

  if (fallbackConversationId?.trim()) return fallbackConversationId.trim();
  return "Antigravity Session";
}
