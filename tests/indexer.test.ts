import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { initSchema, getSessionMeta } from "../src/database";
import type { SessionInfo, FullMessage } from "../src/types";

// ---------------------------------------------------------------------------
// We test the indexer by:
// 1. Mocking the embedder so no real API calls are made
// 2. Using an in-memory SQLite DB
// 3. Overriding the DB path so the indexer uses a temp file
// ---------------------------------------------------------------------------

import { indexNewMessagesWithOptions as indexNewMessages, reindexSession } from "../src/indexer";

const EMBEDDING_DIM = 3072;

// vi.mock is hoisted to the top of the file, so the spy must also be hoisted
// via vi.hoisted() to be accessible inside the factory.
const { embedBatchSpy } = vi.hoisted(() => {
  const embedBatchSpy = vi.fn().mockImplementation(async (texts: string[]) =>
    texts.map(() => Array(EMBEDDING_DIM).fill(0.1)),
  );
  return { embedBatchSpy };
});

// Mock the embedder module before importing indexer
vi.mock("../src/embedder", () => ({
  createEmbedder: () => ({
    embedText: vi.fn().mockResolvedValue(Array(EMBEDDING_DIM).fill(0.1)),
    embedBatch: embedBatchSpy,
  }),
  embedBatch: embedBatchSpy,
}));

// Mock the database module to use a temp file
import { tmpdir } from "os";
import { join } from "path";
import { mkdirSync } from "fs";

function makeTempDbPath(): string {
  const dir = join(tmpdir(), `opencode-memory-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "test.db");
}

function makeSession(id = "ses_001"): SessionInfo {
  return { id, title: "Test Session", directory: "/home/user/proj" };
}

function makeMessages(count: number, startIndex = 0): FullMessage[] {
  const messages: FullMessage[] = [];
  for (let i = 0; i < count; i++) {
    const idx = startIndex + i;
    messages.push({
      info: {
        id: `msg_${String(idx).padStart(3, "0")}`,
        role: idx % 2 === 0 ? "user" : "assistant",
        agent: "build",
        time: { created: 1700000000000 + idx * 1000 },
      },
      parts: [
        {
          type: "text",
          text: `Message ${idx}: This is a test message with enough content to create at least one chunk in the vector database. We need sufficient text here.`,
        },
      ],
    });
  }
  return messages;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("indexNewMessages", () => {
  beforeEach(() => {
    embedBatchSpy.mockClear();
  });

  it("calls embedBatch exactly once regardless of message count", async () => {
    const dbPath = makeTempDbPath();
    const messages = makeMessages(5);
    await indexNewMessages(makeSession(), messages, "opencode", { dbPath });
    // All chunks from all 5 messages should be embedded in a single call
    expect(embedBatchSpy).toHaveBeenCalledTimes(1);
    // The single call should receive all chunks combined (≥5 texts, one per chunk)
    const [allTexts] = embedBatchSpy.mock.calls[0] as [string[]];
    expect(allTexts.length).toBeGreaterThanOrEqual(5);
  });

  it("returns {indexed:0, skipped:0} for empty messages", async () => {
    const dbPath = makeTempDbPath();
    const result = await indexNewMessages(makeSession(), [], "opencode", { dbPath });
    expect(result).toEqual({ indexed: 0, skipped: 0 });
  });

  it("indexes all messages on first run", async () => {
    const dbPath = makeTempDbPath();
    const messages = makeMessages(3);
    const result = await indexNewMessages(makeSession(), messages, "opencode", { dbPath });
    expect(result.indexed).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it("stores last_indexed_message_id in sessions_meta", async () => {
    const dbPath = makeTempDbPath();
    const messages = makeMessages(3);
    await indexNewMessages(makeSession(), messages, "opencode", { dbPath });

    // Read the meta directly
    const db = new Database(dbPath);
    (sqliteVec as unknown as { load: (db: unknown) => void }).load(db);
    initSchema(db as Parameters<typeof initSchema>[0], EMBEDDING_DIM);
    const meta = getSessionMeta(db as Parameters<typeof getSessionMeta>[0], "ses_001");
    db.close();

    expect(meta?.last_indexed_message_id).toBe("msg_002");
  });

  it("skips already-indexed messages on second run", async () => {
    const dbPath = makeTempDbPath();
    const messages = makeMessages(4);

    // First run: index all 4
    const first = await indexNewMessages(makeSession(), messages, "opencode", { dbPath });
    expect(first.indexed).toBe(4);

    // Second run with same messages: nothing new
    const second = await indexNewMessages(makeSession(), messages, "opencode", { dbPath });
    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(4);
  });

  it("indexes only new messages after first run", async () => {
    const dbPath = makeTempDbPath();
    const initialMessages = makeMessages(3);

    // First run
    await indexNewMessages(makeSession(), initialMessages, "opencode", { dbPath });

    // Add 2 more messages
    const allMessages = [...initialMessages, ...makeMessages(2, 3)];
    const second = await indexNewMessages(makeSession(), allMessages, "opencode", { dbPath });

    expect(second.indexed).toBe(2);
    expect(second.skipped).toBe(3);
  });

  it("handles multiple sessions independently", async () => {
    const dbPath = makeTempDbPath();
    const sessionA = makeSession("ses_A");
    const sessionB = makeSession("ses_B");
    const messages = makeMessages(2);

    const resA = await indexNewMessages(sessionA, messages, "opencode", { dbPath });
    const resB = await indexNewMessages(sessionB, messages, "opencode", { dbPath });

    expect(resA.indexed).toBe(2);
    expect(resB.indexed).toBe(2);
  });

  it("skips messages with no renderable content", async () => {
    const dbPath = makeTempDbPath();
    const messages: FullMessage[] = [
      {
        info: { id: "msg_001", role: "assistant", time: {} },
        parts: [{ type: "step-start" }, { type: "step-finish" }],
      },
    ];
    // Should not throw, just skip empty messages
    const result = await indexNewMessages(makeSession(), messages, "opencode", { dbPath });
    expect(result.indexed).toBe(1); // message processed but no chunks created
  });
});

describe("reindexSession", () => {
  it("re-indexes all messages after reset", async () => {
    const dbPath = makeTempDbPath();
    const messages = makeMessages(3);

    // Initial index
    await indexNewMessages(makeSession(), messages, "opencode", { dbPath });

    // Simulate partial new index — there's nothing new
    const second = await indexNewMessages(makeSession(), messages, "opencode", { dbPath });
    expect(second.indexed).toBe(0);

    // Reindex from scratch
    const reindex = await reindexSession(makeSession(), messages, { dbPath });
    expect(reindex.indexed).toBe(3);
  });
});
