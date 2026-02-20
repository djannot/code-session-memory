import { describe, it, expect, vi } from "vitest";
import { createSqliteProvider, createToolHandlers } from "../mcp/server";
import type { QueryResult } from "../src/types";

// ---------------------------------------------------------------------------
// Minimal mocks for DB dependencies
// ---------------------------------------------------------------------------

function makeDbMock(rows: QueryResult[] = []) {
  const stmt = { all: vi.fn().mockReturnValue(rows) };
  const db = { prepare: vi.fn().mockReturnValue(stmt), close: vi.fn() };
  return { db, stmt };
}

function makeFsMock(exists = true) {
  return { existsSync: vi.fn().mockReturnValue(exists) };
}

function makeSqliteVecMock() {
  return { load: vi.fn() };
}

function makeDbCtor(db: ReturnType<typeof makeDbMock>["db"]) {
  return vi.fn().mockReturnValue(db);
}

// ---------------------------------------------------------------------------
// createSqliteProvider
// ---------------------------------------------------------------------------

describe("createSqliteProvider", () => {
  const dbPath = "/fake/sessions.db";

  describe("querySessions", () => {
    it("runs vector search and returns rows", async () => {
      const rows: QueryResult[] = [
        { chunk_id: "c1", content: "some content", url: "session://ses_001#msg_001", distance: 0.1 },
      ];
      const { db } = makeDbMock(rows);
      const provider = createSqliteProvider({
        dbPath,
        sqliteVec: makeSqliteVecMock() as never,
        Database: makeDbCtor(db) as never,
        fs: makeFsMock(),
      });

      const result = await provider.querySessions([0.1, 0.2, 0.3], 5);
      expect(result).toEqual(rows);
      expect(db.prepare).toHaveBeenCalled();
      expect(db.close).toHaveBeenCalled();
    });

    it("throws when database does not exist", async () => {
      const provider = createSqliteProvider({
        dbPath,
        sqliteVec: makeSqliteVecMock() as never,
        Database: makeDbCtor(makeDbMock().db) as never,
        fs: makeFsMock(false),
      });

      await expect(provider.querySessions([0.1], 5)).rejects.toThrow(
        "Database not found",
      );
    });

    it("applies project filter to SQL query", async () => {
      const { db, stmt } = makeDbMock([]);
      const provider = createSqliteProvider({
        dbPath,
        sqliteVec: makeSqliteVecMock() as never,
        Database: makeDbCtor(db) as never,
        fs: makeFsMock(),
      });

      await provider.querySessions([0.1], 5, "/my/project");
      const sqlArg = vi.mocked(db.prepare).mock.calls[0][0] as string;
      expect(sqlArg).toContain("project");
    });
  });

  describe("getSessionChunks", () => {
    it("retrieves chunks ordered by chunk_index", async () => {
      const rows: QueryResult[] = [
        { chunk_id: "c1", content: "chunk 1", chunk_index: 0, total_chunks: 2 },
        { chunk_id: "c2", content: "chunk 2", chunk_index: 1, total_chunks: 2 },
      ];
      const { db } = makeDbMock(rows);
      const provider = createSqliteProvider({
        dbPath,
        sqliteVec: makeSqliteVecMock() as never,
        Database: makeDbCtor(db) as never,
        fs: makeFsMock(),
      });

      const result = await provider.getSessionChunks("session://ses_001#msg_001");
      expect(result).toEqual(rows);
    });

    it("applies startIndex and endIndex filters", async () => {
      const { db } = makeDbMock([]);
      const provider = createSqliteProvider({
        dbPath,
        sqliteVec: makeSqliteVecMock() as never,
        Database: makeDbCtor(db) as never,
        fs: makeFsMock(),
      });

      await provider.getSessionChunks("session://ses_001#msg_001", 2, 5);
      const sqlArg = vi.mocked(db.prepare).mock.calls[0][0] as string;
      expect(sqlArg).toContain("chunk_index >=");
      expect(sqlArg).toContain("chunk_index <=");
    });
  });
});

// ---------------------------------------------------------------------------
// createToolHandlers
// ---------------------------------------------------------------------------

describe("createToolHandlers", () => {
  const mockEmbedding = vi.fn().mockResolvedValue([0.1, 0.2]);

  const makeHandlers = (
    queryResults: QueryResult[] = [],
    chunkResults: QueryResult[] = [],
  ) => {
    return createToolHandlers({
      createEmbedding: mockEmbedding,
      querySessions: vi.fn().mockResolvedValue(queryResults),
      getSessionChunks: vi.fn().mockResolvedValue(chunkResults),
    });
  };

  describe("querySessionsHandler", () => {
    it("returns formatted results on success", async () => {
      const { querySessionsHandler } = makeHandlers([
        {
          chunk_id: "c1",
          content: "test content",
          url: "session://ses_001#msg_001",
          distance: 0.05,
          section: "User",
          chunk_index: 0,
          total_chunks: 1,
        },
      ]);
      const result = await querySessionsHandler({ queryText: "test query" });
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toContain("test content");
      expect(result.content[0].text).toContain("session://ses_001#msg_001");
    });

    it("returns 'not found' message when no results", async () => {
      const { querySessionsHandler } = makeHandlers([]);
      const result = await querySessionsHandler({ queryText: "nothing" });
      expect(result.content[0].text).toContain("No sessions found");
    });

    it("passes project filter to querySessions", async () => {
      const querySessions = vi.fn().mockResolvedValue([]);
      const handlers = createToolHandlers({
        createEmbedding: mockEmbedding,
        querySessions,
        getSessionChunks: vi.fn().mockResolvedValue([]),
      });
      await handlers.querySessionsHandler({
        queryText: "test",
        project: "/my/project",
      });
      expect(querySessions).toHaveBeenCalledWith(
        expect.any(Array),
        expect.any(Number),
        "/my/project",
        undefined,
      );
    });

    it("returns error message on exception", async () => {
      const handlers = createToolHandlers({
        createEmbedding: vi.fn().mockRejectedValue(new Error("API down")),
        querySessions: vi.fn(),
        getSessionChunks: vi.fn(),
      });
      const result = await handlers.querySessionsHandler({ queryText: "test" });
      expect(result.content[0].text).toContain("Error");
      expect(result.content[0].text).toContain("API down");
    });
  });

  describe("getSessionChunksHandler", () => {
    it("returns formatted chunks on success", async () => {
      const { getSessionChunksHandler } = makeHandlers([], [
        { chunk_id: "c1", content: "chunk content", chunk_index: 0, total_chunks: 2 },
        { chunk_id: "c2", content: "more content", chunk_index: 1, total_chunks: 2 },
      ]);
      const result = await getSessionChunksHandler({
        sessionUrl: "session://ses_001#msg_001",
      });
      expect(result.content[0].text).toContain("chunk content");
      expect(result.content[0].text).toContain("more content");
      expect(result.content[0].text).toContain("2 chunk(s)");
    });

    it("returns 'not found' message for unknown URL", async () => {
      const { getSessionChunksHandler } = makeHandlers([], []);
      const result = await getSessionChunksHandler({
        sessionUrl: "session://ses_unknown#msg_x",
      });
      expect(result.content[0].text).toContain("No chunks found");
    });

    it("passes startIndex and endIndex to getSessionChunks", async () => {
      const getSessionChunks = vi.fn().mockResolvedValue([]);
      const handlers = createToolHandlers({
        createEmbedding: mockEmbedding,
        querySessions: vi.fn().mockResolvedValue([]),
        getSessionChunks,
      });
      await handlers.getSessionChunksHandler({
        sessionUrl: "session://ses_001#msg_001",
        startIndex: 2,
        endIndex: 5,
      });
      expect(getSessionChunks).toHaveBeenCalledWith(
        "session://ses_001#msg_001",
        2,
        5,
      );
    });

    it("returns error message on exception", async () => {
      const handlers = createToolHandlers({
        createEmbedding: mockEmbedding,
        querySessions: vi.fn(),
        getSessionChunks: vi.fn().mockRejectedValue(new Error("DB error")),
      });
      const result = await handlers.getSessionChunksHandler({
        sessionUrl: "session://ses_001#msg_001",
      });
      expect(result.content[0].text).toContain("Error");
      expect(result.content[0].text).toContain("DB error");
    });
  });
});
