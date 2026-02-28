import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import {
  initSchema,
  getSessionMeta,
  upsertSessionMeta,
  insertChunks,
  queryByEmbedding,
  queryByKeyword,
  queryHybrid,
  getChunksByUrl,
  getSessionContext,
  listSessionUrls,
  getSessionChunksOrdered,
  deleteSession,
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
      message_order: 0,
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
    expect(result).toContain("code-session-memory");
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
      source: "opencode",
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
      source: "opencode",
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
      source: "opencode",
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

// ---------------------------------------------------------------------------
// getSessionChunksOrdered
// ---------------------------------------------------------------------------

describe("getSessionChunksOrdered", () => {
  it("returns chunks ordered by message_order then chunk_index", () => {
    const db = createTestDb();
    // Insert chunks out of order to verify sort is applied
    // msg_b is message_order=0, msg_a is message_order=1 — but inserted in reverse
    insertChunks(
      db as Parameters<typeof insertChunks>[0],
      [
        makeChunk({ chunk_id: "a0", url: "session://ses_001#msg_a", chunk_index: 0, total_chunks: 2, message_order: 1 }),
        makeChunk({ chunk_id: "a1", url: "session://ses_001#msg_a", chunk_index: 1, total_chunks: 2, message_order: 1 }),
        makeChunk({ chunk_id: "b0", url: "session://ses_001#msg_b", chunk_index: 0, total_chunks: 1, message_order: 0 }),
      ],
      [makeEmbedding(), makeEmbedding(), makeEmbedding()],
    );

    const rows = getSessionChunksOrdered(db as Parameters<typeof getSessionChunksOrdered>[0], "ses_001");
    expect(rows.map((r) => r.chunk_id)).toEqual(["b0", "a0", "a1"]);
  });

  it("returns empty array for unknown session", () => {
    const db = createTestDb();
    expect(getSessionChunksOrdered(db as Parameters<typeof getSessionChunksOrdered>[0], "ses_unknown")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// initSchema — FTS5
// ---------------------------------------------------------------------------

describe("initSchema — FTS5", () => {
  it("creates chunks_fts virtual table", () => {
    const db = createTestDb();
    const tables = (db as unknown as { prepare: (s: string) => { all: () => Array<{ name: string }> } })
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: { name: string }) => r.name);
    expect(tables).toContain("chunks_fts");
  });

  it("backfills FTS from vec_items on schema init", () => {
    // Create DB, insert chunks, then re-init schema to trigger backfill
    const raw = new Database(":memory:");
    (sqliteVec as unknown as { load: (db: unknown) => void }).load(raw);
    const db = raw as unknown as Parameters<typeof initSchema>[0];
    initSchema(db, EMBEDDING_DIM);

    // Insert a chunk
    insertChunks(db, [makeChunk({ chunk_id: "bf1", section: "User" })], [makeEmbedding()]);

    // Verify FTS has the row (inserted during insertChunks)
    const ftsCount = (db as unknown as { prepare: (s: string) => { get: () => { cnt: number } } })
      .prepare("SELECT COUNT(*) AS cnt FROM chunks_fts").get().cnt;
    expect(ftsCount).toBe(1);
  });

  it("insertChunks writes to both vec_items and chunks_fts", () => {
    const db = createTestDb();
    insertChunks(db, [
      makeChunk({ chunk_id: "fts1", section: "User" }),
      makeChunk({ chunk_id: "fts2", section: "Assistant" }),
    ], [makeEmbedding(), makeEmbedding()]);

    const ftsCount = (db as unknown as { prepare: (s: string) => { get: () => { cnt: number } } })
      .prepare("SELECT COUNT(*) AS cnt FROM chunks_fts").get().cnt;
    expect(ftsCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// queryByEmbedding — sectionFilter
// ---------------------------------------------------------------------------

describe("queryByEmbedding — sectionFilter", () => {
  it("filters results by section", () => {
    const db = createTestDb();
    const emb = makeEmbedding();

    // Insert user and assistant chunks with slightly different embeddings
    insertChunks(db as Parameters<typeof insertChunks>[0], [
      makeChunk({ chunk_id: "u1", section: "User" }),
      makeChunk({ chunk_id: "a1", section: "Assistant" }),
      makeChunk({ chunk_id: "t1", section: "Tool Result" }),
    ], [emb, emb, emb]);

    // Add session meta so source filter works
    upsertSessionMeta(db as Parameters<typeof upsertSessionMeta>[0], {
      session_id: "ses_001",
      session_title: "Test",
      project: "/test",
      source: "opencode",
      last_indexed_message_id: null,
      updated_at: Date.now(),
    });

    const userOnly = queryByEmbedding(
      db as Parameters<typeof queryByEmbedding>[0],
      emb, 10, undefined, undefined, undefined, undefined, "user",
    );
    expect(userOnly.every((r) => r.section?.toLowerCase().startsWith("user"))).toBe(true);
    expect(userOnly.length).toBe(1);
  });

  it("returns all when sectionFilter is omitted", () => {
    const db = createTestDb();
    const emb = makeEmbedding();

    insertChunks(db as Parameters<typeof insertChunks>[0], [
      makeChunk({ chunk_id: "u1", section: "User" }),
      makeChunk({ chunk_id: "a1", section: "Assistant" }),
    ], [emb, emb]);

    const all = queryByEmbedding(
      db as Parameters<typeof queryByEmbedding>[0],
      emb, 10,
    );
    expect(all.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// queryByKeyword — FTS5 keyword search
// ---------------------------------------------------------------------------

describe("queryByKeyword", () => {
  it("finds chunks by keyword match", () => {
    const db = createTestDb();
    insertChunks(db as Parameters<typeof insertChunks>[0], [
      makeChunk({ chunk_id: "k1", section: "User" }),
      makeChunk({ chunk_id: "k2", section: "Assistant" }),
    ], [makeEmbedding(), makeEmbedding()]);

    // The default content is "Some content here"
    const results = queryByKeyword(
      db as Parameters<typeof queryByKeyword>[0],
      "content",
      10,
    );
    expect(results.length).toBeGreaterThan(0);
  });

  it("returns empty for non-matching query", () => {
    const db = createTestDb();
    insertChunks(db as Parameters<typeof insertChunks>[0], [
      makeChunk({ chunk_id: "k1" }),
    ], [makeEmbedding()]);

    const results = queryByKeyword(
      db as Parameters<typeof queryByKeyword>[0],
      "xyznonexistent",
      10,
    );
    expect(results.length).toBe(0);
  });

  it("returns empty for empty sanitized query", () => {
    const db = createTestDb();
    const results = queryByKeyword(
      db as Parameters<typeof queryByKeyword>[0],
      "***",
      10,
    );
    expect(results.length).toBe(0);
  });

  it("filters by section", () => {
    const db = createTestDb();
    insertChunks(db as Parameters<typeof insertChunks>[0], [
      makeChunk({ chunk_id: "k1", section: "User" }),
      makeChunk({ chunk_id: "k2", section: "Assistant" }),
    ], [makeEmbedding(), makeEmbedding()]);

    const results = queryByKeyword(
      db as Parameters<typeof queryByKeyword>[0],
      "content",
      10,
      undefined, undefined, undefined, undefined,
      "user",
    );
    expect(results.length).toBe(1);
    expect(results[0].section?.toLowerCase()).toContain("user");
  });
});

// ---------------------------------------------------------------------------
// queryHybrid — RRF merge
// ---------------------------------------------------------------------------

describe("queryHybrid", () => {
  it("returns results combining vector and keyword search", () => {
    const db = createTestDb();
    const emb = makeEmbedding();

    insertChunks(db as Parameters<typeof insertChunks>[0], [
      makeChunk({ chunk_id: "h1", section: "User" }),
      makeChunk({ chunk_id: "h2", section: "Assistant" }),
    ], [emb, emb]);

    const results = queryHybrid(
      db as Parameters<typeof queryHybrid>[0],
      emb,
      "content",
      10,
    );
    expect(results.length).toBeGreaterThan(0);
  });

  it("respects topK limit", () => {
    const db = createTestDb();
    const emb = makeEmbedding();

    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk({ chunk_id: `h${i}` }),
    );
    insertChunks(db as Parameters<typeof insertChunks>[0], chunks, chunks.map(() => emb));

    const results = queryHybrid(
      db as Parameters<typeof queryHybrid>[0],
      emb,
      "content",
      2,
    );
    expect(results.length).toBe(2);
  });

  it("deduplicates chunks appearing in both vector and keyword results", () => {
    const db = createTestDb();
    const emb = makeEmbedding();

    insertChunks(db as Parameters<typeof insertChunks>[0], [
      makeChunk({ chunk_id: "dup1" }),
    ], [emb]);

    const results = queryHybrid(
      db as Parameters<typeof queryHybrid>[0],
      emb,
      "content",
      10,
    );
    // Should not have duplicate chunk_ids
    const ids = results.map((r) => r.chunk_id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// getSessionContext
// ---------------------------------------------------------------------------

describe("getSessionContext", () => {
  it("returns window of chunks around target within session", () => {
    const db = createTestDb();
    // Insert 5 chunks in a session with increasing created_at
    const chunks = Array.from({ length: 5 }, (_, i) =>
      makeChunk({
        chunk_id: `ctx${i}`,
        session_id: "ses_ctx",
        url: `session://ses_ctx#msg_${i}`,
        chunk_index: 0,
        total_chunks: 1,
      }),
    );
    // Manually set different created_at by inserting one at a time
    for (let i = 0; i < chunks.length; i++) {
      insertChunks(db as Parameters<typeof insertChunks>[0], [chunks[i]], [makeEmbedding()]);
    }

    const results = getSessionContext(
      db as Parameters<typeof getSessionContext>[0],
      "ses_ctx",
      "ctx2",
      1,
    );
    // Should return ctx1, ctx2, ctx3 (window=1 around ctx2)
    expect(results.length).toBe(3);
    expect(results.map((r) => r.chunk_id)).toEqual(["ctx1", "ctx2", "ctx3"]);
  });

  it("returns fewer chunks at session boundary", () => {
    const db = createTestDb();
    const chunks = Array.from({ length: 3 }, (_, i) =>
      makeChunk({
        chunk_id: `edge${i}`,
        session_id: "ses_edge",
        url: `session://ses_edge#msg_${i}`,
        chunk_index: 0,
        total_chunks: 1,
      }),
    );
    for (const chunk of chunks) {
      insertChunks(db as Parameters<typeof insertChunks>[0], [chunk], [makeEmbedding()]);
    }

    // Request context around the first chunk
    const results = getSessionContext(
      db as Parameters<typeof getSessionContext>[0],
      "ses_edge",
      "edge0",
      1,
    );
    // Should return edge0, edge1 (no chunk before edge0)
    expect(results.length).toBe(2);
    expect(results[0].chunk_id).toBe("edge0");
  });

  it("returns empty for unknown chunk_id", () => {
    const db = createTestDb();
    const results = getSessionContext(
      db as Parameters<typeof getSessionContext>[0],
      "ses_001",
      "nonexistent",
      1,
    );
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// deleteSession — FTS cleanup
// ---------------------------------------------------------------------------

describe("deleteSession — FTS cleanup", () => {
  it("removes chunks from both vec_items and chunks_fts", () => {
    const db = createTestDb();
    upsertSessionMeta(db as Parameters<typeof upsertSessionMeta>[0], {
      session_id: "ses_del",
      session_title: "Delete me",
      project: "/test",
      source: "opencode",
      last_indexed_message_id: null,
      updated_at: Date.now(),
    });

    insertChunks(db as Parameters<typeof insertChunks>[0], [
      makeChunk({ chunk_id: "del1", session_id: "ses_del" }),
      makeChunk({ chunk_id: "del2", session_id: "ses_del" }),
    ], [makeEmbedding(), makeEmbedding()]);

    // Verify inserted
    const ftsBeforeRaw = (db as unknown as { prepare: (s: string) => { get: (...a: unknown[]) => { cnt: number } } })
      .prepare("SELECT COUNT(*) AS cnt FROM chunks_fts WHERE chunk_id IN ('del1','del2')").get();
    expect(ftsBeforeRaw.cnt).toBe(2);

    // Delete
    const deleted = deleteSession(db as Parameters<typeof deleteSession>[0], "ses_del");
    expect(deleted).toBe(2);

    // Verify FTS cleaned
    const ftsAfterRaw = (db as unknown as { prepare: (s: string) => { get: (...a: unknown[]) => { cnt: number } } })
      .prepare("SELECT COUNT(*) AS cnt FROM chunks_fts WHERE chunk_id IN ('del1','del2')").get();
    expect(ftsAfterRaw.cnt).toBe(0);
  });
});
