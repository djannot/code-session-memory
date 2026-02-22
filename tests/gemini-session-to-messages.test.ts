import { describe, it, expect, vi } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import { mkdirSync } from "fs";

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
  geminiSessionToMessages,
  deriveGeminiSessionTitle,
} from "../src/gemini-session-to-messages";
import { indexNewMessagesWithOptions as indexNewMessages } from "../src/indexer";
import { openDatabase, getSessionMeta, getSessionChunksOrdered } from "../src/database";
import type { SessionInfo, FullMessage } from "../src/types";

const FIXTURE_PATH = path.join(__dirname, "fixtures", "gemini-session.json");
const SESSION_ID = "gemini-session-001";

function makeTempDbPath(): string {
  const dir = path.join(
    os.tmpdir(),
    `opencode-e2e-gemini-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "test.db");
}

function makeSession(id = SESSION_ID): SessionInfo {
  return { id, title: "Gemini E2E Test", directory: "/test/project" };
}

describe("geminiSessionToMessages", () => {
  it("keeps only user/gemini messages and extracts text", () => {
    const messages = geminiSessionToMessages(FIXTURE_PATH);

    expect(messages).toHaveLength(3);
    expect(messages[0].info.role).toBe("user");
    expect(messages[1].info.role).toBe("assistant");
    expect(messages[2].info.role).toBe("assistant");

    expect(messages[0].parts[0]).toMatchObject({
      type: "text",
      text: "Help me wire MCP server for tests.",
    });
  });

  it("maps toolCalls into tool-invocation parts with state/args/result", () => {
    const messages = geminiSessionToMessages(FIXTURE_PATH);
    const assistant = messages.find((m) => m.info.id === "msg-gemini-1");
    expect(assistant).toBeDefined();

    const toolParts = assistant!.parts.filter((p) => p.type === "tool-invocation");
    expect(toolParts).toHaveLength(2);

    expect(toolParts[0]).toMatchObject({
      toolName: "read_file",
      toolCallId: "tool-001",
      state: "result",
      args: { path: "package.json" },
    });
    expect(toolParts[0].result).toContain("firstLine");

    expect(toolParts[1]).toMatchObject({
      toolName: "list_dir",
      toolCallId: "tool-002",
      state: "call",
      args: { path: "src" },
    });
  });

  it("derives title from first user text with fallback", () => {
    const messages = geminiSessionToMessages(FIXTURE_PATH);

    expect(deriveGeminiSessionTitle(messages)).toBe("Help me wire MCP server for tests.");
    expect(deriveGeminiSessionTitle([], "gemini-fallback-1")).toBe("gemini-fallback-1");
    expect(deriveGeminiSessionTitle([])).toBe("Gemini CLI Session");
  });

  it("returns empty messages for invalid JSON input", () => {
    const dir = path.join(os.tmpdir(), `gemini-invalid-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "bad-session.json");
    fs.writeFileSync(p, "{ this-is-not-json", "utf8");

    expect(geminiSessionToMessages(p)).toEqual([]);
  });
});

describe("Gemini e2e: parse -> index -> query", () => {
  it("indexes Gemini messages and stores source=gemini-cli", async () => {
    const dbPath = makeTempDbPath();
    const messages: FullMessage[] = geminiSessionToMessages(FIXTURE_PATH);
    expect(messages.length).toBeGreaterThan(0);

    const session = makeSession();
    const result = await indexNewMessages(session, messages, "gemini-cli", { dbPath });
    expect(result.indexed).toBeGreaterThan(0);

    const db = openDatabase({ dbPath });
    try {
      const meta = getSessionMeta(db, SESSION_ID);
      expect(meta).toBeDefined();
      expect(meta!.source).toBe("gemini-cli");
      expect(meta!.session_title).toBe("Gemini E2E Test");

      const chunks = getSessionChunksOrdered(db, SESSION_ID);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].content).toBeTruthy();
    } finally {
      db.close();
    }
  });
});
