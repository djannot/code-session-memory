/**
 * cli-query.test.ts
 *
 * Tests for the `query` CLI command: argument parsing, date parsing,
 * and end-to-end search against a real in-memory DB (mocked embedder).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "os";
import path from "path";
import { mkdirSync } from "fs";

// ---------------------------------------------------------------------------
// Mock embedder before any imports that touch it
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
// Imports (after mock)
// ---------------------------------------------------------------------------

import { parseQueryArgs, parseDateMs, cmdQuery } from "../src/cli-query";
import { indexNewMessagesWithOptions as indexNewMessages } from "../src/indexer";
import type { FullMessage, SessionInfo } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  const dir = path.join(os.tmpdir(), `csm-cli-query-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "test.db");
}

function makeSession(id = "ses_001", title = "Test Session"): SessionInfo {
  return { id, title, directory: "/home/user/proj" };
}

function makeMessage(id: string, text: string, role: "user" | "assistant" = "assistant"): FullMessage {
  return {
    info: { id, role, time: { created: Date.now() } },
    parts: [{ type: "text", text }],
  };
}

// ---------------------------------------------------------------------------
// parseQueryArgs
// ---------------------------------------------------------------------------

describe("parseQueryArgs", () => {
  it("parses a simple query text", () => {
    const opts = parseQueryArgs(["authentication", "middleware"]);
    expect(opts.queryText).toBe("authentication middleware");
    expect(opts.limit).toBe(5);
    expect(opts.source).toBeUndefined();
    expect(opts.fromMs).toBeUndefined();
    expect(opts.toMs).toBeUndefined();
  });

  it("parses --limit", () => {
    const opts = parseQueryArgs(["auth", "--limit", "10"]);
    expect(opts.queryText).toBe("auth");
    expect(opts.limit).toBe(10);
  });

  it("parses --source opencode", () => {
    const opts = parseQueryArgs(["auth", "--source", "opencode"]);
    expect(opts.source).toBe("opencode");
  });

  it("parses --source claude-code", () => {
    const opts = parseQueryArgs(["auth", "--source", "claude-code"]);
    expect(opts.source).toBe("claude-code");
  });

  it("parses --source cursor", () => {
    const opts = parseQueryArgs(["auth", "--source", "cursor"]);
    expect(opts.source).toBe("cursor");
  });

  it("parses --from and --to date strings", () => {
    const opts = parseQueryArgs(["auth", "--from", "2026-02-01", "--to", "2026-02-20"]);
    expect(opts.fromMs).toBe(Date.parse("2026-02-01"));
    // --to end-of-day: add 24h-1ms
    expect(opts.toMs).toBe(Date.parse("2026-02-20") + 24 * 60 * 60 * 1000 - 1);
  });

  it("throws when query text is missing", () => {
    expect(() => parseQueryArgs([])).toThrow("Query text is required");
  });

  it("throws on invalid --source value", () => {
    expect(() => parseQueryArgs(["auth", "--source", "vscode"])).toThrow('Invalid --source "vscode"');
  });

  it("throws on invalid --limit value", () => {
    expect(() => parseQueryArgs(["auth", "--limit", "abc"])).toThrow('Invalid --limit "abc"');
  });

  it("throws on non-positive --limit", () => {
    expect(() => parseQueryArgs(["auth", "--limit", "0"])).toThrow('Invalid --limit "0"');
  });

  it("throws on invalid --from date", () => {
    expect(() => parseQueryArgs(["auth", "--from", "not-a-date"])).toThrow('Invalid --from date');
  });

  it("throws on unknown flag", () => {
    expect(() => parseQueryArgs(["auth", "--project", "/foo"])).toThrow('Unknown flag "--project"');
  });

  it("throws when --source has no value", () => {
    expect(() => parseQueryArgs(["auth", "--source"])).toThrow("--source requires a value");
  });
});

// ---------------------------------------------------------------------------
// parseDateMs
// ---------------------------------------------------------------------------

describe("parseDateMs", () => {
  it("parses date-only start as UTC midnight", () => {
    const ms = parseDateMs("2026-02-01", "start");
    expect(ms).toBe(Date.parse("2026-02-01"));
  });

  it("parses date-only end as end of UTC day", () => {
    const ms = parseDateMs("2026-02-01", "end");
    expect(ms).toBe(Date.parse("2026-02-01") + 24 * 60 * 60 * 1000 - 1);
  });

  it("parses datetime string as-is", () => {
    const ms = parseDateMs("2026-02-01T15:00:00Z", "end");
    expect(ms).toBe(Date.parse("2026-02-01T15:00:00Z"));
  });

  it("returns null for invalid date", () => {
    expect(parseDateMs("not-a-date", "start")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cmdQuery — end-to-end (mocked embedder + real temp DB)
// ---------------------------------------------------------------------------

describe("cmdQuery", () => {
  let dbPath: string;
  const originalEnv = process.env.OPENAI_API_KEY;
  const originalArgv = process.argv;
  const originalExit = process.exit;

  beforeEach(async () => {
    process.env.OPENAI_API_KEY = "test-key";
    dbPath = makeTempDbPath();

    // Override DB path via env
    process.env.OPENCODE_MEMORY_DB_PATH = dbPath;

    // Seed the DB with two sessions from different sources
    await indexNewMessages(
      makeSession("ses_opencode", "Auth flow"),
      [makeMessage("msg_001", "We implemented JWT authentication middleware using Express.js for the API routes.")],
      "opencode",
      { dbPath },
    );
    await indexNewMessages(
      makeSession("ses_claude", "Migration guide"),
      [makeMessage("msg_002", "The database migration uses Alembic to manage schema changes incrementally.")],
      "claude-code",
      { dbPath },
    );
  });

  // Restore globals after each test
  beforeEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit as typeof process.exit;
  });

  it("prints results to stdout without error", async () => {
    const lines: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const origLog = console.log;
    const logged: string[] = [];
    console.log = (...args: unknown[]) => { logged.push(args.join(" ")); };

    try {
      await cmdQuery(["authentication", "middleware"]);
    } finally {
      console.log = origLog;
      vi.restoreAllMocks();
    }

    // Should have printed at least the header
    const output = logged.join("\n");
    expect(output).toContain("Found");
    expect(output).toContain("authentication middleware");
  });

  it("respects --limit flag", async () => {
    // With limit=1 we should get at most 1 result
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.join(" ")); };

    try {
      await cmdQuery(["auth", "--limit", "1"]);
    } finally {
      console.log = origLog;
    }

    const output = logged.join("\n");
    expect(output).toContain("limit=1");
    // Should not contain "2." result header
    expect(output).not.toMatch(/\n2\./);
  });

  it("respects --source filter", async () => {
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.join(" ")); };

    try {
      await cmdQuery(["auth", "--source", "opencode"]);
    } finally {
      console.log = origLog;
    }

    const output = logged.join("\n");
    expect(output).toContain("source=opencode");
  });

  it("exits with code 1 when query text is missing", async () => {
    let exitCode: number | undefined;
    process.exit = ((code: number) => { exitCode = code; }) as typeof process.exit;
    const origError = console.error;
    console.error = () => {};

    try {
      await cmdQuery([]);
    } finally {
      console.error = origError;
    }

    expect(exitCode).toBe(1);
  });

  it("exits with code 1 when OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY;
    let exitCode: number | undefined;
    process.exit = ((code: number) => { exitCode = code; }) as typeof process.exit;
    const origError = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => { errors.push(args.join(" ")); };

    try {
      await cmdQuery(["auth"]);
    } finally {
      console.error = origError;
      process.env.OPENAI_API_KEY = "test-key";
    }

    expect(exitCode).toBe(1);
    expect(errors.join(" ")).toContain("OPENAI_API_KEY");
  });

  it("prints no-results message when nothing matches", async () => {
    // Filter to cursor source which has no data
    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.join(" ")); };

    try {
      await cmdQuery(["auth", "--source", "cursor"]);
    } finally {
      console.log = origLog;
    }

    const output = logged.join("\n");
    expect(output).toContain("No results found");
  });
});
