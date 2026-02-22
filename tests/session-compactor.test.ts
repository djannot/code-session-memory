/**
 * session-compactor.test.ts
 *
 * Tests for the session-compactor module:
 * - buildTranscript assembles chunks into readable text
 * - splitIntoWindows handles small and large inputs
 * - compactSession: single-pass (small session)
 * - compactSession: multi-pass (long session, map-reduce)
 * - compactSession: respects max output token target (passed to API)
 * - compactSession: aggregates token usage across all passes
 * - compactSession: sets low reasoning effort for reasoning-capable models
 * - compactSession: throws when OPENAI_API_KEY is missing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ChunkRow } from "../src/database";

// ---------------------------------------------------------------------------
// Mock OpenAI before importing the module under test
// ---------------------------------------------------------------------------

const mockCreate = vi.fn();

vi.mock("openai", () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: mockCreate,
        },
      };
    },
  };
});

import {
  buildTranscript,
  splitIntoWindows,
  compactSession,
} from "../src/session-compactor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChunk(
  section: string,
  content: string,
  overrides: Partial<ChunkRow> = {},
): ChunkRow {
  return {
    chunk_id: `chunk_${Math.random().toString(36).slice(2)}`,
    chunk_index: 0,
    total_chunks: 1,
    section,
    heading_hierarchy: "[]",
    content,
    url: "session://ses_001#msg_001",
    ...overrides,
  };
}

/** Build a fake OpenAI response object. */
function fakeResponse(
  content: string,
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number },
) {
  return {
    choices: [{ message: { content } }],
    usage,
  };
}

// ---------------------------------------------------------------------------
// buildTranscript
// ---------------------------------------------------------------------------

describe("buildTranscript", () => {
  it("returns empty string for no chunks", () => {
    expect(buildTranscript([])).toBe("");
  });

  it("groups consecutive same-section chunks under one header", () => {
    const chunks = [
      makeChunk("User", "Hello there"),
      makeChunk("User", "More from user"),
      makeChunk("Assistant", "Hi! How can I help?"),
    ];
    const transcript = buildTranscript(chunks);

    // Should have exactly one "### User" header
    const userHeaders = (transcript.match(/### User/g) ?? []).length;
    expect(userHeaders).toBe(1);

    // Should have one "### Assistant" header
    const assistantHeaders = (transcript.match(/### Assistant/g) ?? []).length;
    expect(assistantHeaders).toBe(1);

    expect(transcript).toContain("Hello there");
    expect(transcript).toContain("More from user");
    expect(transcript).toContain("Hi! How can I help?");
  });

  it("adds a new header when section changes", () => {
    const chunks = [
      makeChunk("User", "First message"),
      makeChunk("Assistant", "First reply"),
      makeChunk("User", "Second message"),
    ];
    const transcript = buildTranscript(chunks);

    const userHeaders = (transcript.match(/### User/g) ?? []).length;
    expect(userHeaders).toBe(2);
  });

  it("uses 'Unknown' for chunks with empty section", () => {
    const chunks = [makeChunk("", "No section content")];
    const transcript = buildTranscript(chunks);
    expect(transcript).toContain("### Unknown");
    expect(transcript).toContain("No section content");
  });
});

// ---------------------------------------------------------------------------
// splitIntoWindows
// ---------------------------------------------------------------------------

describe("splitIntoWindows", () => {
  it("returns the original text as a single window when small enough", () => {
    const text = "short text";
    const windows = splitIntoWindows(text, 1000);
    expect(windows).toEqual([text]);
  });

  it("splits into multiple windows when text exceeds window size", () => {
    // 10 chars per window, 25 chars total → 3 windows
    const text = "aaaaaaaaaa\nbbbbbbbbbb\nccccc";
    const windows = splitIntoWindows(text, 10);
    expect(windows.length).toBeGreaterThan(1);
    // All content is preserved
    expect(windows.join("")).toBe(text);
  });

  it("prefers to split on newline boundaries", () => {
    // Window is 15 chars; the newline is at position 10
    const text = "helloworld\nfoo bar baz";
    const windows = splitIntoWindows(text, 15);
    // First window should end at or near the newline
    expect(windows[0]).toBe("helloworld\n");
    expect(windows[1]).toBe("foo bar baz");
  });

  it("handles text with no newlines gracefully", () => {
    const text = "a".repeat(50);
    const windows = splitIntoWindows(text, 20);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows.join("")).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// compactSession — OPENAI_API_KEY guard
// ---------------------------------------------------------------------------

describe("compactSession — API key guard", () => {
  const originalKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env.OPENAI_API_KEY = originalKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("throws when OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(
      compactSession([makeChunk("User", "test")]),
    ).rejects.toThrow("OPENAI_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// compactSession — single-pass (small session)
// ---------------------------------------------------------------------------

describe("compactSession — single pass", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    mockCreate.mockReset();
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("performs 2 API calls (map + final format) for a small session", async () => {
    // Map pass response
    mockCreate
      .mockResolvedValueOnce(fakeResponse("Digest of the session.", {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
      }))
      // Final formatting pass response
      .mockResolvedValueOnce(fakeResponse("## Context\nTest project\n\n## Unresolved Issues\nNone.", {
        prompt_tokens: 60,
        completion_tokens: 30,
        total_tokens: 90,
      }));

    const chunks = [
      makeChunk("User", "Fix the auth bug"),
      makeChunk("Assistant", "I found the issue in auth.ts"),
    ];

    const result = await compactSession(chunks);

    expect(result.passes).toBe(2); // 1 map + 1 final format
    expect(result.summary).toContain("Context");
    expect(result.usage).toEqual({
      inputTokens: 160,
      outputTokens: 80,
      totalTokens: 240,
    });
    expect(mockCreate).toHaveBeenCalledTimes(2);
  });

  it("passes max_completion_tokens to the OpenAI API", async () => {
    mockCreate
      .mockResolvedValue(fakeResponse("summary"));

    const chunks = [makeChunk("User", "test")];
    await compactSession(chunks, { maxOutputTokens: 1234 });

    // Both calls should use max_completion_tokens: 1234
    for (const call of mockCreate.mock.calls) {
      expect(call[0].max_completion_tokens).toBe(1234);
    }
  });

  it("uses low reasoning effort for the default gpt-5-nano model", async () => {
    mockCreate.mockResolvedValue(fakeResponse("ok"));

    const chunks = [makeChunk("User", "test")];
    await compactSession(chunks);

    for (const call of mockCreate.mock.calls) {
      expect(call[0].reasoning_effort).toBe("low");
    }
  });

  it("uses the model from options", async () => {
    mockCreate.mockResolvedValue(fakeResponse("ok"));

    const chunks = [makeChunk("User", "test")];
    await compactSession(chunks, { model: "gpt-4o" });

    for (const call of mockCreate.mock.calls) {
      expect(call[0].model).toBe("gpt-4o");
    }
  });

  it("does not set reasoning_effort for non-reasoning models", async () => {
    mockCreate.mockResolvedValue(fakeResponse("ok"));

    const chunks = [makeChunk("User", "test")];
    await compactSession(chunks, { model: "gpt-4o" });

    for (const call of mockCreate.mock.calls) {
      expect(call[0].reasoning_effort).toBeUndefined();
    }
  });

  it("uses OPENAI_SUMMARY_MODEL env var as default model", async () => {
    process.env.OPENAI_SUMMARY_MODEL = "gpt-4o-mini";
    mockCreate.mockResolvedValue(fakeResponse("ok"));

    const chunks = [makeChunk("User", "test")];
    await compactSession(chunks);

    expect(mockCreate.mock.calls[0][0].model).toBe("gpt-4o-mini");
    delete process.env.OPENAI_SUMMARY_MODEL;
  });

  it("returns the model name in the result", async () => {
    mockCreate.mockResolvedValue(fakeResponse("ok"));

    const chunks = [makeChunk("User", "test")];
    const result = await compactSession(chunks, { model: "gpt-4.5-mini" });

    expect(result.model).toBe("gpt-4.5-mini");
  });

  it("final prompt excludes Next Steps and continuation prompt sections", async () => {
    mockCreate
      .mockResolvedValueOnce(fakeResponse("digest"))
      .mockResolvedValueOnce(fakeResponse("final"));

    const chunks = [makeChunk("User", "test")];
    await compactSession(chunks);

    const finalCall = mockCreate.mock.calls[1][0];
    const systemPrompt = finalCall.messages.find(
      (m: { role: string; content: string }) => m.role === "system",
    )?.content;

    expect(systemPrompt).toContain("## Unresolved Issues");
    expect(systemPrompt).not.toContain("## Next Steps");
    expect(systemPrompt).not.toContain("CONTINUATION PROMPT");
  });
});

// ---------------------------------------------------------------------------
// compactSession — multi-pass (long session, map-reduce)
// ---------------------------------------------------------------------------

describe("compactSession — multi-pass (map-reduce)", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    mockCreate.mockReset();
  });

  afterEach(() => {
    delete process.env.OPENAI_API_KEY;
  });

  it("performs map + reduce + final passes for a long session", async () => {
    // Build a transcript long enough to exceed the single-pass threshold (400k chars).
    // We'll patch splitIntoWindows by creating chunks whose combined transcript is large.
    // Instead, let's mock splitIntoWindows via a large chunk count.
    // Easiest: pass a big string as chunk content.
    const bigContent = "x".repeat(210_000); // 210k chars per chunk, 2 chunks = 420k > 400k
    const chunks = [
      makeChunk("User", bigContent),
      makeChunk("Assistant", bigContent),
    ];

    // Map call 1 (window 1), Map call 2 (window 2), Reduce call, Final format call
    mockCreate
      .mockResolvedValueOnce(fakeResponse("Partial summary 1", {
        prompt_tokens: 100,
        completion_tokens: 20,
        total_tokens: 120,
      }))
      .mockResolvedValueOnce(fakeResponse("Partial summary 2", {
        prompt_tokens: 120,
        completion_tokens: 25,
        total_tokens: 145,
      }))
      .mockResolvedValueOnce(fakeResponse("Merged digest", {
        prompt_tokens: 80,
        completion_tokens: 30,
        total_tokens: 110,
      }))
      .mockResolvedValueOnce(fakeResponse("## Context\nFull summary\n\n## Unresolved Issues\nNone.", {
        prompt_tokens: 70,
        completion_tokens: 40,
        total_tokens: 110,
      }));

    const result = await compactSession(chunks);

    // passes = 2 (map) + 1 (reduce) + 1 (final) = 4
    expect(result.passes).toBe(4);
    expect(result.usage).toEqual({
      inputTokens: 370,
      outputTokens: 115,
      totalTokens: 485,
    });
    expect(mockCreate).toHaveBeenCalledTimes(4);
  });

  it("passes the merged partial summaries to the reduce step", async () => {
    const bigContent = "y".repeat(210_000);
    const chunks = [
      makeChunk("User", bigContent),
      makeChunk("Assistant", bigContent),
    ];

    mockCreate
      .mockResolvedValueOnce(fakeResponse("Part A"))
      .mockResolvedValueOnce(fakeResponse("Part B"))
      .mockResolvedValueOnce(fakeResponse("Merged"))
      .mockResolvedValueOnce(fakeResponse("Final"));

    await compactSession(chunks);

    // The 3rd call (reduce) should receive a user message containing both partial summaries
    const reduceCall = mockCreate.mock.calls[2][0];
    const userMessage = reduceCall.messages.find((m: { role: string }) => m.role === "user");
    expect(userMessage.content).toContain("Part A");
    expect(userMessage.content).toContain("Part B");
  });

  it("treats missing usage fields as zero", async () => {
    const bigContent = "z".repeat(210_000);
    const chunks = [
      makeChunk("User", bigContent),
      makeChunk("Assistant", bigContent),
    ];

    mockCreate
      .mockResolvedValueOnce(fakeResponse("Part A"))
      .mockResolvedValueOnce(fakeResponse("Part B", { prompt_tokens: 5, completion_tokens: 2 }))
      .mockResolvedValueOnce(fakeResponse("Merged"))
      .mockResolvedValueOnce(fakeResponse("Final", { total_tokens: 10 }));

    const result = await compactSession(chunks);

    expect(result.usage).toEqual({
      inputTokens: 5,
      outputTokens: 2,
      totalTokens: 17,
    });
  });
});
