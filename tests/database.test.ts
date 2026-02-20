import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {
  initSchema,
  getSessionMeta,
  upsertSessionMeta,
  insertChunks,
  queryByEmbedding,
  getChunksByUrl,
  listSessionUrls,
  resolveDbPath,
} from "../src/database";
import type { DocumentChunk, SessionMeta } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers to create an in-memory DB for tests
// ---------------------------------------------------------------------------

const EMBEDDING_DIM = 8; // Tiny dimension for fast tests

function createTestDb() {
  const db = new Database(":memory:") as unknown as Parameters<typeof initSchema>[0];
  (sqliteVec as unknown as { load: (db: unknown) => void }).load(db);
  initSchema(db as Parameters<typeof initSchema>[0], EMBEDDING_DIM);
  return db;
}

function makeChunk(overrides: Partial<DocumentChunk["metadata"]> = {}): DocumentChunk {
  return {
    content: "[Session: Test > Section]\n\nSome content here",
    metadata: {
      session_id: "ses_001",
      session_title: "Test Session",
      project: "/home/user/project",
      heading_hierarchy: ["Test", "Section"],
      section: "Section",
      chunk_id: `chunk_${Math.random().toString(36).slice(2)}`,
      url: "session://ses_001#msg_001",
      hash: "abc123",
      chunk_index: 0,
      total_chunks: 1,
      ...overrides,
    },
  };
}

function makeEmbedding(dim = EMBEDDING_DIM): number[] {
  return Array.from({ length: dim }, (_, i) => (i + 1) / dim);
}

// ---------------------------------------------------------------------------
// resolveDbPath
// ---------------------------------------------------------------------------

describe("resolveDbPath", () => {
  it("uses OPENCODE_MEMORY_DB_PATH env var", () => {
    process.env.OPENCODE_MEMORY_DB_PATH = "/tmp/test.db";
    expect(resolveDbPath()).toBe("/tmp/test.db");
    delete process.env.OPENCODE_MEMORY_DB_PATH;
  });

  it("uses explicit overridePath parameter", () => {
    delete process.env.OPENCODE_MEMORY_DB_PATH;
    expect(resolveDbPath("/custom/path.db")).toBe("/custom/path.db");
  });

  it("expands ~ in override path", () => {
    const result = resolveDbPath("~/test.db");
    expect(result).not.toContain("~");
    expect(result).toContain("test.db");
  });

  it("returns default path when no overrides", () => {
    delete process.env.OPENCODE_MEMORY_DB_PATH;
    const result = resolveDbPath();
    expect(result).toContain("opencode-memory");
    expect(result).toContain("sessions.db");
  });
});

// ---------------------------------------------------------------------------
// initSchema
// ---------------------------------------------------------------------------

describe("initSchema", () => {
  it("creates vec_items table", () => {
    const db = createTestDb();
    const tables = (db as unknown as { prepare: (s: string) => { all: () => Array<{ name: string }> } })
      .prepare("SELECT name FROM sqlite_master WHERE type='table' OR type='shadow'")
      .all()
      .map((r: { name: string }) => r.name);
    expect(tables).toContain("sessions_meta");
  });

  it("creates sessions_meta table", () => {
    const db = createTestDb();
    const tables = (db as unknown as { prepare: (s: string) => { all: () => Array<{ name: string }> } })
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: { name: string }) => r.name);
    expect(tables).toContain("sessions_meta");
  });

  it("is idempotent (can be called multiple times)", () => {
    const db = createTestDb();
    expect(() => initSchema(db as Parameters<typeof initSchema>[0], EMBEDDING_DIM)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sessions_meta CRUD
// ---------------------------------------------------------------------------

describe("getSessionMeta / upsertSessionMeta", () => {
  it("returns null for unknown session", () => {
    const db = createTestDb();
    expect(getSessionMeta(db as Parameters<typeof getSessionMeta>[0], "ses_unknown")).toBeNull();
  });

  it("inserts and retrieves session meta", () => {
    const db = createTestDb();
    const meta: SessionMeta = {
      session_id: "ses_001",
      session_title: "My Session",
      project: "/home/user/proj",
      last_indexed_message_id: "msg_005",
      updated_at: 1700000000000,
    };
    upsertSessionMeta(db as Parameters<typeof upsertSessionMeta>[0], meta);
    const retrieved = getSessionMeta(db as Parameters<typeof getSessionMeta>[0], "ses_001");
    expect(retrieved).toMatchObject(meta);
  });

  it("updates existing meta on conflict", () => {
    const db = createTestDb();
    const meta: SessionMeta = {
      session_id: "ses_001",
      session_title: "Old Title",
      project: "/old",
      last_indexed_message_id: "msg_001",
      updated_at: 1000,
    };
    upsertSessionMeta(db as Parameters<typeof upsertSessionMeta>[0], meta);

    const updated: SessionMeta = {
      ...meta,
      session_title: "New Title",
      last_indexed_message_id: "msg_010",
      updated_at: 2000,
    };
    upsertSessionMeta(db as Parameters<typeof upsertSessionMeta>[0], updated);

    const retrieved = getSessionMeta(db as Parameters<typeof getSessionMeta>[0], "ses_001");
    expect(retrieved?.session_title).toBe("New Title");
    expect(retrieved?.last_indexed_message_id).toBe("msg_010");
  });

  it("stores null last_indexed_message_id", () => {
    const db = createTestDb();
    const meta: SessionMeta = {
      session_id: "ses_002",
      session_title: "Session",
      project: "/proj",
      last_indexed_message_id: null,
      updated_at: 0,
    };
    upsertSessionMeta(db as Parameters<typeof upsertSessionMeta>[0], meta);
    const retrieved = getSessionMeta(db as Parameters<typeof getSessionMeta>[0], "ses_002");
    expect(retrieved?.last_indexed_message_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// insertChunks
// ---------------------------------------------------------------------------

describe("insertChunks", () => {
  it("inserts a single chunk", () => {
    const db = createTestDb();
    const chunk = makeChunk();
    insertChunks(
      db as Parameters<typeof insertChunks>[0],
      [chunk],
      [makeEmbedding()],
    );
    const count = (db as unknown as { prepare: (s: string) => { get: () => { n: number } } })
      .prepare("SELECT COUNT(*) as n FROM vec_items")
      .get().n;
    expect(count).toBe(1);
  });

  it("inserts multiple chunks in a transaction", () => {
    const db = createTestDb();
    const chunks = [makeChunk(), makeChunk(), makeChunk()];
    const embeddings = chunks.map(() => makeEmbedding());
    insertChunks(db as Parameters<typeof insertChunks>[0], chunks, embeddings);
    const count = (db as unknown as { prepare: (s: string) => { get: () => { n: number } } })
      .prepare("SELECT COUNT(*) as n FROM vec_items")
      .get().n;
    expect(count).toBe(3);
  });

  it("silently ignores duplicate chunk_ids (INSERT OR IGNORE)", () => {
    const db = createTestDb();
    const chunk = makeChunk({ chunk_id: "dup_chunk" });
    insertChunks(db as Parameters<typeof insertChunks>[0], [chunk], [makeEmbedding()]);
    insertChunks(db as Parameters<typeof insertChunks>[0], [chunk], [makeEmbedding()]);
    const count = (db as unknown as { prepare: (s: string) => { get: () => { n: number } } })
      .prepare("SELECT COUNT(*) as n FROM vec_items")
      .get().n;
    expect(count).toBe(1);
  });

  it("throws when chunks and embeddings lengths mismatch", () => {
    const db = createTestDb();
    expect(() =>
      insertChunks(
        db as Parameters<typeof insertChunks>[0],
        [makeChunk()],
        [makeEmbedding(), makeEmbedding()],
      ),
    ).toThrow("Mismatch");
  });

  it("is a no-op for empty arrays", () => {
    const db = createTestDb();
    expect(() =>
      insertChunks(db as Parameters<typeof insertChunks>[0], [], []),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// queryByEmbedding
// ---------------------------------------------------------------------------

describe("queryByEmbedding", () => {
  it("returns closest chunks by distance", () => {
    const db = createTestDb();
    const emb1 = makeEmbedding(); // [0.125, 0.25, ...]
    const emb2 = Array.from({ length: EMBEDDING_DIM }, () => 0); // zero vector

    insertChunks(
      db as Parameters<typeof insertChunks>[0],
      [
        makeChunk({ chunk_id: "c1", url: "session://ses_001#msg_001" }),
        makeChunk({ chunk_id: "c2", url: "session://ses_001#msg_002" }),
      ],
      [emb1, emb2],
    );

    const results = queryByEmbedding(
      db as Parameters<typeof queryByEmbedding>[0],
      emb1,
      5,
    );
    expect(results.length).toBe(2);
    // c1 should be closest (exact match)
    expect(results[0].chunk_id).toBe("c1");
  });

  it("filters by project", () => {
    const db = createTestDb();
    insertChunks(
      db as Parameters<typeof insertChunks>[0],
      [
        makeChunk({ chunk_id: "c1", session_id: "ses_a" }),
        makeChunk({ chunk_id: "c2", session_id: "ses_b" }),
      ],
      [makeEmbedding(), makeEmbedding()],
    );

    // Insert a chunk with a different project
    const db2Chunk = makeChunk({ chunk_id: "c3" });
    db2Chunk.metadata.project = "/other/project";
    insertChunks(
      db as Parameters<typeof insertChunks>[0],
      [db2Chunk],
      [makeEmbedding()],
    );

    const results = queryByEmbedding(
      db as Parameters<typeof queryByEmbedding>[0],
      makeEmbedding(),
      10,
      "/home/user/project",
    );
    expect(results.every((r) => (r as { project?: string }).project === "/home/user/project")).toBe(true);
    expect(results.find((r) => r.chunk_id === "c3")).toBeUndefined();
  });

  it("respects topK limit", () => {
    const db = createTestDb();
    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk({ chunk_id: `c${i}` }),
    );
    insertChunks(
      db as Parameters<typeof insertChunks>[0],
      chunks,
      chunks.map(() => makeEmbedding()),
    );
    const results = queryByEmbedding(
      db as Parameters<typeof queryByEmbedding>[0],
      makeEmbedding(),
      3,
    );
    expect(results.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// getChunksByUrl
// ---------------------------------------------------------------------------

describe("getChunksByUrl", () => {
  it("retrieves chunks for a specific URL in order", () => {
    const db = createTestDb();
    const url = "session://ses_001#msg_001";
    insertChunks(
      db as Parameters<typeof insertChunks>[0],
      [
        makeChunk({ chunk_id: "c1", url, chunk_index: 0, total_chunks: 3 }),
        makeChunk({ chunk_id: "c2", url, chunk_index: 1, total_chunks: 3 }),
        makeChunk({ chunk_id: "c3", url, chunk_index: 2, total_chunks: 3 }),
      ],
      [makeEmbedding(), makeEmbedding(), makeEmbedding()],
    );

    const results = getChunksByUrl(db as Parameters<typeof getChunksByUrl>[0], url);
    expect(results.length).toBe(3);
    expect(results.map((r) => r.chunk_id)).toEqual(["c1", "c2", "c3"]);
  });

  it("returns empty array for unknown URL", () => {
    const db = createTestDb();
    const results = getChunksByUrl(
      db as Parameters<typeof getChunksByUrl>[0],
      "session://unknown#msg",
    );
    expect(results).toEqual([]);
  });

  it("filters by startIndex", () => {
    const db = createTestDb();
    const url = "session://ses_001#msg_002";
    insertChunks(
      db as Parameters<typeof insertChunks>[0],
      [
        makeChunk({ chunk_id: "c1", url, chunk_index: 0, total_chunks: 3 }),
        makeChunk({ chunk_id: "c2", url, chunk_index: 1, total_chunks: 3 }),
        makeChunk({ chunk_id: "c3", url, chunk_index: 2, total_chunks: 3 }),
      ],
      [makeEmbedding(), makeEmbedding(), makeEmbedding()],
    );

    const results = getChunksByUrl(db as Parameters<typeof getChunksByUrl>[0], url, 1);
    expect(results.length).toBe(2);
    expect(results[0].chunk_id).toBe("c2");
  });

  it("filters by endIndex", () => {
    const db = createTestDb();
    const url = "session://ses_001#msg_003";
    insertChunks(
      db as Parameters<typeof insertChunks>[0],
      [
        makeChunk({ chunk_id: "c1", url, chunk_index: 0, total_chunks: 3 }),
        makeChunk({ chunk_id: "c2", url, chunk_index: 1, total_chunks: 3 }),
        makeChunk({ chunk_id: "c3", url, chunk_index: 2, total_chunks: 3 }),
      ],
      [makeEmbedding(), makeEmbedding(), makeEmbedding()],
    );

    const results = getChunksByUrl(db as Parameters<typeof getChunksByUrl>[0], url, undefined, 1);
    expect(results.length).toBe(2);
    expect(results.map((r) => r.chunk_id)).toEqual(["c1", "c2"]);
  });
});

// ---------------------------------------------------------------------------
// listSessionUrls
// ---------------------------------------------------------------------------

describe("listSessionUrls", () => {
  it("returns distinct URLs for a session", () => {
    const db = createTestDb();
    insertChunks(
      db as Parameters<typeof insertChunks>[0],
      [
        makeChunk({ chunk_id: "c1", url: "session://ses_001#msg_001" }),
        makeChunk({ chunk_id: "c2", url: "session://ses_001#msg_001" }),
        makeChunk({ chunk_id: "c3", url: "session://ses_001#msg_002" }),
      ],
      [makeEmbedding(), makeEmbedding(), makeEmbedding()],
    );

    const urls = listSessionUrls(db as Parameters<typeof listSessionUrls>[0], "ses_001");
    expect(urls).toHaveLength(2);
    expect(urls).toContain("session://ses_001#msg_001");
    expect(urls).toContain("session://ses_001#msg_002");
  });

  it("returns empty array for unknown session", () => {
    const db = createTestDb();
    expect(listSessionUrls(db as Parameters<typeof listSessionUrls>[0], "ses_unknown")).toEqual([]);
  });
});
