import { describe, it, expect, vi } from "vitest";
import path from "path";
import os from "os";
import { mkdirSync } from "fs";
import fs from "fs";

const EMBEDDING_DIM = 3072;

vi.mock("../src/embedder", () => ({
  createEmbedder: () => ({
    embedText: vi.fn().mockResolvedValue(Array(EMBEDDING_DIM).fill(0.1)),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) =>
      texts.map(() => Array(EMBEDDING_DIM).fill(0.1)),
    ),
  }),
}));

import {
  codexSessionToMessages,
  deriveCodexSessionTitle,
} from "../src/codex-session-to-messages";
import { indexNewMessagesWithOptions as indexNewMessages } from "../src/indexer";
import { openDatabase, getSessionMeta, getSessionChunksOrdered } from "../src/database";
import type { SessionInfo, FullMessage } from "../src/types";

const FIXTURE_PATH = path.join(__dirname, "fixtures", "codex-session.jsonl");
const SESSION_ID = "codex-test-thread-001";

function makeTempDbPath(): string {
  const dir = path.join(
    os.tmpdir(),
    `opencode-e2e-codex-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "test.db");
}

function makeSession(id = SESSION_ID): SessionInfo {
  return { id, title: "Codex E2E Test", directory: "/test/project" };
}

describe("codexSessionToMessages", () => {
  it("extracts exactly one clean user message from event_msg.user_message", () => {
    const messages = codexSessionToMessages(FIXTURE_PATH);
    const userMessages = messages.filter((m) => m.info.role === "user");

    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].parts[0]).toMatchObject({
      type: "text",
      text: "What's this project about?",
    });

    const userText = userMessages[0].parts[0].type === "text"
      ? userMessages[0].parts[0].text ?? ""
      : "";
    expect(userText).not.toContain("<environment_context>");
    expect(userText).not.toContain("<permissions");
  });

  it("extracts exactly one assistant final answer and skips commentary", () => {
    const messages = codexSessionToMessages(FIXTURE_PATH);
    const assistants = messages.filter((m) => m.info.role === "assistant");

    expect(assistants).toHaveLength(1);

    const textPart = assistants[0].parts.find((p) => p.type === "text");
    expect(textPart?.text).toBe("This is a test project with a README.");
  });

  it("pairs function_call with function_call_output as tool-invocation result", () => {
    const messages = codexSessionToMessages(FIXTURE_PATH);
    const assistant = messages.find((m) => m.info.role === "assistant");
    expect(assistant).toBeDefined();

    const toolPart = assistant!.parts.find((p) => p.type === "tool-invocation");
    expect(toolPart).toBeDefined();
    expect(toolPart?.toolName).toBe("exec_command");
    expect(toolPart?.state).toBe("result");
    expect(toolPart?.toolCallId).toBe("call-001");
    expect(toolPart?.result).toContain("README.md");
    expect(toolPart?.args).toEqual({ cmd: "ls -la" });
  });
});

describe("per-model analytics (turn_context + token_count)", () => {
  function writeRollout(lines: object[]): string {
    const dir = path.join(os.tmpdir(), `codex-usage-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "rollout.jsonl");
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return file;
  }
  const ts = "2026-09-08T10:00:00.000Z";
  const ev = (payload: object) => ({ timestamp: ts, type: "event_msg", payload });
  const ri = (payload: object) => ({ timestamp: ts, type: "response_item", payload });
  const answer = (text: string) => ri({ type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] });

  it("attaches the turn's model and the sum of its token_count events to the turn's assistant message", () => {
    const file = writeRollout([
      { timestamp: ts, type: "session_meta", payload: { id: "t1" } },
      ev({ type: "task_started", turn_id: "turn-a" }),
      { timestamp: ts, type: "turn_context", payload: { turn_id: "turn-a", model: "gpt-5.4" } },
      ev({ type: "user_message", message: "first question" }),
      // rate-limit-only event: no usage
      ev({ type: "token_count", info: null, rate_limits: {} }),
      ev({ type: "token_count", info: { last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 1050 }, total_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 1050 } } }),
      ri({ type: "function_call", name: "exec_command", arguments: "{}", call_id: "c1" }),
      ri({ type: "function_call_output", call_id: "c1", output: "ok" }),
      ev({ type: "token_count", info: { last_token_usage: { input_tokens: 2000, cached_input_tokens: 1500, cache_write_input_tokens: 100, output_tokens: 30, reasoning_output_tokens: 0, total_tokens: 2030 }, total_token_usage: { input_tokens: 3000, cached_input_tokens: 2100, cache_write_input_tokens: 100, output_tokens: 80, reasoning_output_tokens: 10, total_tokens: 3080 } } }),
      answer("first answer"),
      ev({ type: "task_complete" }),
      // second turn on another model
      ev({ type: "task_started", turn_id: "turn-b" }),
      { timestamp: ts, type: "turn_context", payload: { turn_id: "turn-b", model: "codex-auto-review" } },
      ev({ type: "user_message", message: "second question" }),
      ev({ type: "token_count", info: { last_token_usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 520 } } }),
      answer("second answer"),
      ev({ type: "task_complete" }),
    ]);

    const messages = codexSessionToMessages(file);
    const assistants = messages.filter((m) => m.info.role === "assistant");
    expect(assistants).toHaveLength(2);

    const [a, b] = assistants;
    expect(a.info.modelID).toBe("gpt-5.4");
    // input = input_tokens - cached - cache_write, summed over the two calls
    expect(a.info.tokens).toEqual({
      input: (1000 - 600) + (2000 - 1500 - 100),
      output: 80,
      reasoning: 10,
      total: 3000 + 80,
      cache: { read: 2100, write: 100 },
    });

    expect(b.info.modelID).toBe("codex-auto-review");
    expect(b.info.tokens).toEqual({ input: 500, output: 20, reasoning: 5, total: 520, cache: { read: 0, write: 0 } });

    // user messages never carry a model or usage
    for (const u of messages.filter((m) => m.info.role === "user")) {
      expect(u.info.modelID).toBeUndefined();
      expect(u.info.tokens).toBeUndefined();
    }
  });

  it("derives per-call usage from cumulative totals when last_token_usage is absent", () => {
    const file = writeRollout([
      ev({ type: "task_started", turn_id: "turn-a" }),
      { timestamp: ts, type: "turn_context", payload: { model: "gpt-5.3-codex" } },
      ev({ type: "user_message", message: "q1" }),
      ev({ type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10, reasoning_output_tokens: 0 } } }),
      answer("a1"),
      ev({ type: "task_complete" }),
      ev({ type: "task_started", turn_id: "turn-b" }),
      ev({ type: "user_message", message: "q2" }),
      ev({ type: "token_count", info: { total_token_usage: { input_tokens: 400, cached_input_tokens: 50, output_tokens: 25, reasoning_output_tokens: 3 } } }),
      answer("a2"),
      ev({ type: "task_complete" }),
    ]);
    const [a, b] = codexSessionToMessages(file).filter((m) => m.info.role === "assistant");
    expect(a.info.tokens).toEqual({ input: 100, output: 10, reasoning: 0, total: 110, cache: { read: 0, write: 0 } });
    // model persists when a turn has no turn_context of its own
    expect(b.info.modelID).toBe("gpt-5.3-codex");
    expect(b.info.tokens).toEqual({ input: 250, output: 15, reasoning: 3, total: 315, cache: { read: 50, write: 0 } });
  });

  it("does not double count a token_count snapshot that Codex repeats at the end of a turn", () => {
    const usage = { last_token_usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 40, reasoning_output_tokens: 8 }, total_token_usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 40, reasoning_output_tokens: 8 } };
    const file = writeRollout([
      ev({ type: "task_started", turn_id: "turn-a" }),
      { timestamp: ts, type: "turn_context", payload: { model: "gpt-6-astra" } },
      ev({ type: "user_message", message: "q" }),
      ev({ type: "token_count", info: usage }),
      ev({ type: "token_count", info: usage }), // identical repeat
      answer("a"),
      ev({ type: "task_complete" }),
    ]);
    const [a] = codexSessionToMessages(file).filter((m) => m.info.role === "assistant");
    expect(a.info.tokens).toEqual({ input: 200, output: 40, reasoning: 8, total: 340, cache: { read: 100, write: 0 } });
  });

  it("leaves model and tokens undefined when the rollout has no turn_context / token_count", () => {
    const messages = codexSessionToMessages(FIXTURE_PATH);
    const asst = messages.find((m) => m.info.role === "assistant")!;
    expect(asst.info.modelID).toBeUndefined();
    expect(asst.info.tokens).toBeUndefined();
  });
});

describe("deriveCodexSessionTitle", () => {
  it("derives title from first user message", () => {
    const messages = codexSessionToMessages(FIXTURE_PATH);
    expect(deriveCodexSessionTitle(messages)).toBe("What's this project about?");
  });

  it("falls back to assistant text then default", () => {
    expect(deriveCodexSessionTitle([], "Final assistant summary")).toBe("Final assistant summary");
    expect(deriveCodexSessionTitle([])).toBe("Codex Session");
  });
});

describe("assistant fallback behavior", () => {
  it("emits assistant message from agent_message when no final_answer exists", () => {
    const dir = path.join(os.tmpdir(), `codex-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "session.jsonl");
    const lines = [
      "{\"timestamp\":\"2026-02-22T10:00:00.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\",\"turn_id\":\"turn-x\"}}",
      "{\"timestamp\":\"2026-02-22T10:00:01.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"user_message\",\"message\":\"Find projects\"}}",
      "{\"timestamp\":\"2026-02-22T10:00:02.000Z\",\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"assistant\",\"phase\":\"commentary\",\"content\":[{\"type\":\"output_text\",\"text\":\"I will inspect sessions.\"}]}}",
      "{\"timestamp\":\"2026-02-22T10:00:03.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\",\"message\":\"You worked on /a and /b.\"}}",
      "{\"timestamp\":\"2026-02-22T10:00:04.000Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"turn-x\"}}",
    ];
    fs.writeFileSync(p, lines.join("\n"), "utf8");

    const messages = codexSessionToMessages(p);
    const assistants = messages.filter((m) => m.info.role === "assistant");
    expect(assistants).toHaveLength(1);
    const text = assistants[0].parts.find((part) => part.type === "text");
    expect(text?.text).toBe("You worked on /a and /b.");
  });
});

describe("Codex e2e: parse -> index -> query", () => {
  it("indexes Codex messages and stores source=codex", async () => {
    const dbPath = makeTempDbPath();
    const messages: FullMessage[] = codexSessionToMessages(FIXTURE_PATH);
    expect(messages.length).toBeGreaterThan(0);

    const session = makeSession();
    const result = await indexNewMessages(session, messages, "codex", { dbPath });
    expect(result.indexed).toBeGreaterThan(0);

    const db = openDatabase({ dbPath });
    try {
      const meta = getSessionMeta(db, SESSION_ID);
      expect(meta).toBeDefined();
      expect(meta!.source).toBe("codex");
      expect(meta!.session_title).toBe("Codex E2E Test");

      const chunks = getSessionChunksOrdered(db, SESSION_ID);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].content).toBeTruthy();
    } finally {
      db.close();
    }
  });
});
