/**
 * vscode-transcript-to-messages.test.ts
 *
 * Tests for the VS Code transcript parser:
 *   JSONL fixture → parseVscodeTranscript → FullMessage[]
 *
 * Uses a committed fixture file (tests/fixtures/vscode-session.jsonl).
 */

import { describe, it, expect, vi, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import os from "os";

// ---------------------------------------------------------------------------
// Mock embedder before importing anything that touches it
// ---------------------------------------------------------------------------

const EMBEDDING_DIM = 3072;

vi.mock("../src/embedder", () => ({
  createEmbedder: () => ({
    embedText: vi.fn().mockResolvedValue(Array(EMBEDDING_DIM).fill(0.1)),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) =>
      texts.map(() => Array(EMBEDDING_DIM).fill(0.1)),
    ),
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mock setup)
// ---------------------------------------------------------------------------

import {
  parseVscodeTranscript,
  deriveVscodeSessionTitle,
} from "../src/vscode-transcript-to-messages";
import { indexNewMessagesWithOptions as indexNewMessages } from "../src/indexer";
import { openDatabase, getSessionMeta, getSessionChunksOrdered } from "../src/database";
import type { SessionInfo, FullMessage } from "../src/types";
import { mkdirSync } from "fs";
import { join } from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES = path.join(__dirname, "fixtures");
const FIXTURE_PATH = path.join(FIXTURES, "vscode-session.jsonl");
const SESSION_ID = "vscode-test-session-001";

function makeTempDbPath(): string {
  const dir = join(
    os.tmpdir(),
    `opencode-e2e-vscode-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return join(dir, "test.db");
}

function makeSession(id = SESSION_ID): SessionInfo {
  return { id, title: "VS Code E2E Test", directory: "/test/project" };
}

// ---------------------------------------------------------------------------
// Parse tests (no DB)
// ---------------------------------------------------------------------------

describe("parseVscodeTranscript", () => {
  let messages: FullMessage[];

  beforeAll(() => {
    messages = parseVscodeTranscript(FIXTURE_PATH);
  });

  it("produces at least one message", () => {
    expect(messages.length).toBeGreaterThan(0);
  });

  it("parses user messages", () => {
    const userMessages = messages.filter((m) => m.info.role === "user");
    expect(userMessages.length).toBeGreaterThanOrEqual(2);
  });

  it("parses assistant messages", () => {
    const assistantMessages = messages.filter((m) => m.info.role === "assistant");
    expect(assistantMessages.length).toBeGreaterThanOrEqual(2);
  });

  it("extracts user text content", () => {
    const firstUser = messages.find((m) => m.info.role === "user");
    expect(firstUser).toBeDefined();
    expect(firstUser!.parts[0].type).toBe("text");
    expect(firstUser!.parts[0].text).toContain("package.json");
  });

  it("extracts assistant text content", () => {
    const textAssistants = messages.filter(
      (m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text"),
    );
    expect(textAssistants.length).toBeGreaterThanOrEqual(1);
  });

  it("extracts tool invocations from assistant messages", () => {
    const toolCalls = messages.filter(
      (m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "tool-invocation"),
    );
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    const call = toolCalls[0].parts.find((p) => p.type === "tool-invocation");
    expect(call?.toolName).toBe("readFile");
  });

  it("pairs tool results with tool calls in assistant messages", () => {
    const toolCalls = messages.filter(
      (m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "tool-invocation"),
    );
    const call = toolCalls[0].parts.find((p) => p.type === "tool-invocation");
    expect(call?.state).toBe("result");
    expect(call?.result).toContain("my-project");
  });

  it("does not produce standalone tool role messages", () => {
    const toolMessages = messages.filter((m) => m.info.role === "tool");
    expect(toolMessages.length).toBe(0);
  });
});

describe("deriveVscodeSessionTitle", () => {
  it("derives title from first user message", () => {
    const messages = parseVscodeTranscript(FIXTURE_PATH);
    const title = deriveVscodeSessionTitle(messages);
    expect(title).toContain("package.json");
  });

  it("returns default title for empty messages", () => {
    const title = deriveVscodeSessionTitle([]);
    expect(title).toBe("VS Code Session");
  });
});

// ---------------------------------------------------------------------------
// E2E: parse → index → query (with DB)
// ---------------------------------------------------------------------------

describe("VS Code e2e: parse → index → query", () => {
  it("indexes VS Code transcript and retrieves chunks", async () => {
    const dbPath = makeTempDbPath();
    const messages = parseVscodeTranscript(FIXTURE_PATH);
    expect(messages.length).toBeGreaterThan(0);

    const session = makeSession();
    const result = await indexNewMessages(session, messages, "vscode", { dbPath });
    expect(result.indexed).toBeGreaterThan(0);

    // Verify session metadata
    const db = openDatabase({ dbPath });
    try {
      const meta = getSessionMeta(db, SESSION_ID);
      expect(meta).toBeDefined();
      expect(meta!.source).toBe("vscode");
      expect(meta!.session_title).toBe("VS Code E2E Test");

      // Verify chunks were stored
      const chunks = getSessionChunksOrdered(db, SESSION_ID);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].content).toBeTruthy();
    } finally {
      db.close();
    }
  });

  it("incremental indexing skips already-indexed messages", async () => {
    const dbPath = makeTempDbPath();
    const messages = parseVscodeTranscript(FIXTURE_PATH);
    const session = makeSession();

    // First index
    const r1 = await indexNewMessages(session, messages, "vscode", { dbPath });
    expect(r1.indexed).toBeGreaterThan(0);

    // Second index — same messages, nothing new
    const r2 = await indexNewMessages(session, messages, "vscode", { dbPath });
    expect(r2.indexed).toBe(0);
    expect(r2.skipped).toBeGreaterThan(0);
  });
});
