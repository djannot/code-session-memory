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
