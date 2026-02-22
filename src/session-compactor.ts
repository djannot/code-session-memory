/**
 * session-compactor.ts — summarize a session's chunks into a compact restart document.
 *
 * Uses OpenAI chat completions with a map-reduce strategy for long sessions:
 *   1. Single-pass for sessions whose estimated token count fits within the limit.
 *   2. Multi-pass for longer sessions: map each window → reduce all partials → final format.
 *
 * Environment variables:
 *   OPENAI_API_KEY               Required. Passed to the OpenAI client.
 *   OPENAI_SUMMARY_MODEL         Override model (default: "gpt-5-nano").
 *   CSM_SUMMARY_MAX_OUTPUT_TOKENS Override max output tokens (default: 5000).
 */

import OpenAI from "openai";
import type { ChunkRow } from "./database";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CompactOptions {
  /** Override the summarizer model. Default: OPENAI_SUMMARY_MODEL env var or "gpt-5-nano". */
  model?: string;
  /** Override the max output token budget. Default: CSM_SUMMARY_MAX_OUTPUT_TOKENS env var or 5000. */
  maxOutputTokens?: number;
}

export interface CompactResult {
  summary: string;
  model: string;
  /** Total number of LLM passes performed (map passes + reduce + final format). */
  passes: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

/**
 * Summarizes the given ordered chunks into a restart document ready to paste
 * into a new AI coding session.
 *
 * @throws Error if OPENAI_API_KEY is missing or any OpenAI call fails.
 */
export async function compactSession(
  chunks: ChunkRow[],
  options: CompactOptions = {},
): Promise<CompactResult> {
  const model =
    options.model ??
    process.env.OPENAI_SUMMARY_MODEL ??
    "gpt-5-nano";

  const maxOutputTokens =
    options.maxOutputTokens ??
    Number(process.env.CSM_SUMMARY_MAX_OUTPUT_TOKENS ?? "5000");

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY environment variable is required for session compaction.",
    );
  }

  const client = new OpenAI({ apiKey });
  const useLowReasoningEffort = supportsLowReasoningEffort(model);
  const usageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  async function runCompletion(messages: Array<{ role: "system" | "user"; content: string }>, maxCompletionTokens: number): Promise<string> {
    const response = await client.chat.completions.create({
      model,
      max_completion_tokens: maxCompletionTokens,
      ...(useLowReasoningEffort ? { reasoning_effort: "low" as const } : {}),
      messages,
    });

    const promptTokens = response.usage?.prompt_tokens ?? 0;
    const completionTokens = response.usage?.completion_tokens ?? 0;
    const totalTokens = response.usage?.total_tokens ?? (promptTokens + completionTokens);
    usageTotals.inputTokens += promptTokens;
    usageTotals.outputTokens += completionTokens;
    usageTotals.totalTokens += totalTokens;

    return response.choices[0]?.message?.content ?? "";
  }

  const transcript = buildTranscript(chunks);

  // Single-pass threshold: ~100k tokens (≈ 400k chars).
  const SINGLE_PASS_CHAR_LIMIT = 400_000;

  let digest: string;
  let passes: number;

  if (transcript.length <= SINGLE_PASS_CHAR_LIMIT) {
    // Single pass: summarize the whole transcript at once.
    digest = await runCompletion(
      [
        { role: "system", content: MAP_SYSTEM_PROMPT },
        { role: "user", content: transcript },
      ],
      maxOutputTokens,
    );
    passes = 1;
  } else {
    // Multi-pass: split into ~80k-token windows (~320k chars), map then reduce.
    const WINDOW_CHARS = 320_000;
    const windows = splitIntoWindows(transcript, WINDOW_CHARS);

    // Map phase: summarize each window independently.
    const partials: string[] = [];
    const perWindowTokens = Math.max(
      500,
      Math.ceil(maxOutputTokens / windows.length),
    );
    for (const window of windows) {
      const partial = await runCompletion(
        [
          { role: "system", content: MAP_SYSTEM_PROMPT },
          { role: "user", content: window },
        ],
        perWindowTokens,
      );
      partials.push(partial);
    }

    // Reduce phase: merge all partial summaries.
    const combined = partials.join("\n\n---\n\n");
    digest = await runCompletion(
      [
        { role: "system", content: REDUCE_SYSTEM_PROMPT },
        { role: "user", content: combined },
      ],
      maxOutputTokens,
    );
    passes = windows.length + 1; // N map passes + 1 reduce pass
  }

  // Final formatting pass: structure the digest into a restart document.
  const summary = await runCompletion(
    [
      {
        role: "system",
        content: finalSystemPrompt(maxOutputTokens),
      },
      { role: "user", content: digest },
    ],
    maxOutputTokens,
  );
  passes += 1;

  return { summary, model, passes, usage: usageTotals };
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

const MAP_SYSTEM_PROMPT = `\
You are summarizing a segment of an AI coding session transcript.

Extract a concise faithful digest that preserves, in chronological order:
- Key decisions made and their rationale
- Failed attempts and why they failed
- Constraints and requirements discovered during the session
- Code file paths, function names, and data structures mentioned
- Unresolved issues or open questions

Be concise and structured. Use bullet points. Preserve technical specifics.
Do NOT add opinions or filler. Only what's in the transcript.`;

const REDUCE_SYSTEM_PROMPT = `\
You are merging partial summaries of an AI coding session into a single coherent digest.

Combine the summaries into one continuous narrative that:
- Preserves chronological order
- Includes all unique key decisions and rationale
- Includes all failed attempts and lessons learned
- Includes all constraints and requirements
- Includes all code file paths, function names, and data structures
- Includes all unresolved issues and remaining work

Remove redundancy. Preserve all unique technical details.
Output bullet-point lists, not prose paragraphs.`;

function finalSystemPrompt(maxOutputTokens: number): string {
  return `\
You are creating a "session restart document" for an AI coding session.

Transform the session digest into a structured document with these sections:

## Context
What was being built or fixed, and why.

## Key Decisions
Architectural and implementation choices made during the session.

## Current State
What was completed, what is in progress, and what files/code exist now.

## Unresolved Issues
Blockers, open questions, or known bugs not yet fixed.

Keep the total output under ${maxOutputTokens} tokens. Be precise and actionable.
Preserve every technical detail (file paths, function names, error messages).`;
}

function supportsLowReasoningEffort(model: string): boolean {
  const normalized = model.toLowerCase();
  return normalized.startsWith("gpt-5") || normalized.startsWith("o1") || normalized.startsWith("o3") || normalized.startsWith("o4");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a human-readable transcript from ordered chunk rows.
 * Groups consecutive chunks with the same section label under a single header.
 */
export function buildTranscript(chunks: ChunkRow[]): string {
  if (chunks.length === 0) return "";

  const lines: string[] = [];
  let lastSection = "";

  for (const chunk of chunks) {
    const section = chunk.section || "Unknown";
    if (section !== lastSection) {
      lines.push(`\n### ${section}`);
      lastSection = section;
    }
    lines.push(chunk.content);
  }

  return lines.join("\n").trimStart();
}

/**
 * Splits `text` into windows of at most `windowChars` characters.
 * Splits on newline boundaries when possible.
 */
export function splitIntoWindows(text: string, windowChars: number): string[] {
  if (text.length <= windowChars) return [text];

  const windows: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    let end = Math.min(offset + windowChars, text.length);

    // Try to find the last newline before the hard boundary.
    if (end < text.length) {
      const lastNl = text.lastIndexOf("\n", end);
      if (lastNl > offset) end = lastNl + 1;
    }

    windows.push(text.slice(offset, end));
    offset = end;
  }

  return windows;
}
