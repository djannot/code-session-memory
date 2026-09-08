/**
 * model-analytics.test.ts
 *
 * Per-model analytics: model + token usage captured per assistant message,
 * turn indexing, the SQLite schema migration for existing databases, the
 * upsert that backfills continued sessions, getModelStats(), and the
 * backfill-analytics command.
 */

import { describe, it, expect, vi } from "vitest";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import fs from "fs";
import os from "os";
import path from "path";

const EMBEDDING_DIM = 3072;

vi.mock("../src/embedder", () => ({
  createEmbedder: () => ({
    embedText: vi.fn().mockResolvedValue(Array(EMBEDDING_DIM).fill(0.1)),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) =>
      texts.map(() => Array(EMBEDDING_DIM).fill(0.1)),
    ),
  }),
}));

import { parseTranscript } from "../src/transcript-to-messages";
import { indexNewMessagesWithOptions as indexNewMessages, extractAnalyticsData } from "../src/indexer";
import { openDatabase, getModelStats, initSchema, upsertSessionMeta } from "../src/database";
import { SqliteDatabaseProvider } from "../src/providers/sqlite-provider";
import { backfillAnalytics } from "../src/analytics-backfill";
import type { FullMessage, MessageRow } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES = path.join(__dirname, "fixtures");
const CLAUDE_FIXTURE = path.join(FIXTURES, "claude-session.jsonl");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(FIXTURES, "manifest.json"), "utf8")) as {
  claude_session_id: string;
  opencode_session_id: string;
};

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `csm-model-analytics-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function loadOpenCodeFixture(): { info: { id: string; title?: string; directory?: string }; messages: FullMessage[] } {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, "opencode-session.json"), "utf8"));
}

/** Reads the analytics rows straight from the messages table. */
function readMessageRows(dbPath: string, sessionId: string): MessageRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY message_order").all(sessionId) as MessageRow[];
  } finally {
    db.close();
  }
}

/** The exact `messages` DDL shipped before the per-model columns existed. */
const LEGACY_MESSAGES_DDL = `
  CREATE TABLE messages (
    id              TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    role            TEXT NOT NULL,
    created_at      INTEGER,
    text_length     INTEGER NOT NULL DEFAULT 0,
    part_count      INTEGER NOT NULL DEFAULT 0,
    tool_call_count INTEGER NOT NULL DEFAULT 0,
    message_order   INTEGER NOT NULL DEFAULT 0,
    indexed_at      INTEGER NOT NULL,
    PRIMARY KEY (session_id, id)
  )
`;

/** Expected per-message usage from the raw JSONL: one entry per message.id (all lines repeat the same usage). */
function rawUsageByMessageId(): Map<string, { output: number; cacheRead: number }> {
  const out = new Map<string, { output: number; cacheRead: number }>();
  for (const line of fs.readFileSync(CLAUDE_FIXTURE, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const d = JSON.parse(line);
    if (d.type !== "assistant" || !d.message?.usage) continue;
    out.set(d.message.id, {
      output: d.message.usage.output_tokens ?? 0,
      cacheRead: d.message.usage.cache_read_input_tokens ?? 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parsing: Claude Code transcript → modelID + tokens
// ---------------------------------------------------------------------------

describe("parseTranscript model + token usage", () => {
  const messages = parseTranscript(CLAUDE_FIXTURE);
  const assistants = messages.filter((m) => m.info.role === "assistant");

  it("sets modelID on every assistant message", () => {
    expect(assistants.length).toBeGreaterThan(0);
    for (const m of assistants) {
      expect(m.info.modelID).toBeTruthy();
      expect(m.info.modelID!.startsWith("<")).toBe(false);
    }
  });

  it("counts each API response's usage exactly once even though the JSONL repeats it per content block", () => {
    const expected = rawUsageByMessageId();
    const expectedOutput = [...expected.values()].reduce((a, u) => a + u.output, 0);
    const expectedCacheRead = [...expected.values()].reduce((a, u) => a + u.cacheRead, 0);
    const gotOutput = assistants.reduce((a, m) => a + (m.info.tokens?.output ?? 0), 0);
    const gotCacheRead = assistants.reduce((a, m) => a + (m.info.tokens?.cache?.read ?? 0), 0);
    expect(gotOutput).toBe(expectedOutput);
    expect(gotCacheRead).toBe(expectedCacheRead);
    expect(gotOutput).toBeGreaterThan(0);
  });

  it("never sets tokens on user messages", () => {
    for (const m of messages.filter((x) => x.info.role === "user")) {
      expect(m.info.tokens).toBeUndefined();
      expect(m.info.modelID).toBeUndefined();
    }
  });

  it("drops Claude Code placeholder models like <synthetic> and normalizes usage fields", () => {
    const dir = makeTempDir();
    const file = path.join(dir, "t.jsonl");
    const ts = "2026-03-01T10:00:00.000Z";
    const lines = [
      { type: "user", uuid: "u1", timestamp: ts, sessionId: "s", message: { role: "user", content: "hello" } },
      {
        type: "assistant", uuid: "a1", timestamp: ts, sessionId: "s",
        message: {
          id: "m1", role: "assistant", model: "claude-opus-5",
          content: [{ type: "text", text: "hi there" }],
          usage: {
            input_tokens: 5, output_tokens: 40, cache_creation_input_tokens: 100,
            cache_read_input_tokens: 1000, output_tokens_details: { thinking_tokens: 12 },
          },
        },
      },
      {
        type: "assistant", uuid: "a2", timestamp: ts, sessionId: "s",
        message: { id: "m2", role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "No response requested." }] },
      },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const parsed = parseTranscript(file);
    const [real, synthetic] = parsed.filter((m) => m.info.role === "assistant");
    expect(real.info.modelID).toBe("claude-opus-5");
    expect(real.info.tokens).toEqual({
      input: 5, output: 40, reasoning: 12, total: 5 + 40 + 1000 + 100, cache: { read: 1000, write: 100 },
    });
    expect(synthetic.info.modelID).toBeUndefined();
    expect(synthetic.info.tokens).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractAnalyticsData: turn index + model columns
// ---------------------------------------------------------------------------

describe("extractAnalyticsData", () => {
  it("assigns a turn index that increments at every user message and stores model/tokens on assistant rows", () => {
    const messages: FullMessage[] = [
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "q1" }] },
      { info: { id: "a1", role: "assistant", modelID: "claude-opus-5", tokens: { input: 1, output: 10, cache: { read: 50, write: 5 }, reasoning: 2 } }, parts: [{ type: "tool-invocation", toolName: "Read", toolCallId: "t1", state: "result", args: {}, result: "x" }] },
      { info: { id: "a2", role: "assistant", modelID: "claude-sonnet-5", providerID: "anthropic", cost: 0.01, tokens: { input: 2, output: 20 } }, parts: [{ type: "text", text: "done" }] },
      { info: { id: "u2", role: "user" }, parts: [{ type: "text", text: "q2" }] },
      { info: { id: "a3", role: "assistant", modelID: "claude-opus-5" }, parts: [{ type: "text", text: "ok" }] },
    ];
    const { messageRows } = extractAnalyticsData(messages, "ses", 1);
    expect(messageRows.map((r) => r.turn_index)).toEqual([0, 0, 0, 1, 1]);
    expect(messageRows.map((r) => r.model)).toEqual([null, "claude-opus-5", "claude-sonnet-5", null, "claude-opus-5"]);

    const a1 = messageRows[1];
    expect(a1.tool_call_count).toBe(1);
    expect(a1.input_tokens).toBe(1);
    expect(a1.output_tokens).toBe(10);
    expect(a1.cache_read_tokens).toBe(50);
    expect(a1.cache_write_tokens).toBe(5);
    expect(a1.reasoning_tokens).toBe(2);
    expect(a1.provider).toBeNull();
    expect(a1.cost).toBeNull();

    const a2 = messageRows[2];
    expect(a2.provider).toBe("anthropic");
    expect(a2.cost).toBe(0.01);
    expect(a2.cache_read_tokens).toBeNull();

    // No usage reported → token columns stay NULL (not 0), so averages ignore them
    const a3 = messageRows[4];
    expect(a3.input_tokens).toBeNull();
    expect(a3.output_tokens).toBeNull();
  });

  it("starts turn 0 even when the session begins with an assistant message", () => {
    const messages: FullMessage[] = [
      { info: { id: "a0", role: "assistant", modelID: "m" }, parts: [{ type: "text", text: "hi" }] },
      { info: { id: "u1", role: "user" }, parts: [{ type: "text", text: "q" }] },
    ];
    const { messageRows } = extractAnalyticsData(messages, "ses", 1);
    expect(messageRows.map((r) => r.turn_index)).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// Indexing end-to-end into SQLite + getModelStats
// ---------------------------------------------------------------------------

describe("per-model analytics through the indexer", () => {
  it("stores model + tokens for a Claude Code session and aggregates them per model", async () => {
    const dbPath = path.join(makeTempDir(), "test.db");
    const messages = parseTranscript(CLAUDE_FIXTURE);
    const sessionId = MANIFEST.claude_session_id;
    await indexNewMessages({ id: sessionId, title: "t", directory: "/p" }, messages, "claude-code", { dbPath });

    const rows = readMessageRows(dbPath, sessionId);
    const assistants = rows.filter((r) => r.role === "assistant");
    const users = rows.filter((r) => r.role === "user");
    expect(assistants.every((r) => r.model !== null && r.output_tokens !== null)).toBe(true);
    expect(users.every((r) => r.model === null && r.output_tokens === null)).toBe(true);
    expect(new Set(rows.map((r) => r.turn_index)).size).toBe(users.length);

    const db = openDatabase({ dbPath });
    try {
      const stats = getModelStats(db);
      expect(stats.length).toBeGreaterThan(0);
      expect(stats.reduce((a, s) => a + s.message_count, 0)).toBe(assistants.length);
      expect(stats.reduce((a, s) => a + s.output_tokens, 0)).toBe(assistants.reduce((a, r) => a + (r.output_tokens ?? 0), 0));
      expect(stats.reduce((a, s) => a + s.tool_call_count, 0)).toBe(assistants.reduce((a, r) => a + r.tool_call_count, 0));
      for (const s of stats) {
        expect(s.sources).toBe("claude-code");
        expect(s.session_count).toBe(1);
        expect(s.turn_count).toBeGreaterThan(0);
        expect(s.turn_count).toBeLessThanOrEqual(users.length);
        expect(s.messages_with_tokens).toBe(s.message_count);
        expect(s.cost).toBeNull();
      }
      // Source filter works, and a non-matching source yields nothing
      expect(getModelStats(db, { source: "claude-code" }).length).toBe(stats.length);
      expect(getModelStats(db, { source: "opencode" })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("stores provider, tokens and cost for an OpenCode session", async () => {
    const dbPath = path.join(makeTempDir(), "test.db");
    const fixture = loadOpenCodeFixture();
    await indexNewMessages({ id: fixture.info.id, title: "t", directory: "/p" }, fixture.messages, "opencode", { dbPath });

    const assistants = readMessageRows(dbPath, fixture.info.id).filter((r) => r.role === "assistant");
    expect(assistants.length).toBeGreaterThan(0);
    expect(assistants.every((r) => r.model !== null && r.provider !== null)).toBe(true);
    expect(assistants.some((r) => (r.cost ?? 0) > 0)).toBe(true);
    expect(assistants.some((r) => (r.cache_read_tokens ?? 0) > 0)).toBe(true);

    const db = openDatabase({ dbPath });
    try {
      const stats = getModelStats(db);
      expect(stats.length).toBeGreaterThan(0);
      expect(stats[0].sources).toBe("opencode");
      expect(stats[0].provider).toBe(assistants[0].provider);
      expect(stats.reduce((a, s) => a + (s.cost ?? 0), 0)).toBeCloseTo(
        assistants.reduce((a, r) => a + (r.cost ?? 0), 0), 6,
      );
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Upgrade path: existing DB without the new columns
// ---------------------------------------------------------------------------

describe("upgrade from a database created before per-model analytics", () => {
  function createLegacyDb(dbPath: string, sessionId: string, messages: FullMessage[], indexedUpTo: number): void {
    // Build a DB that looks like one written by the previous version: full
    // schema, but the messages table lacks the new columns and its rows carry
    // no model. The session is indexed up to message `indexedUpTo`.
    const db = new Database(dbPath);
    (sqliteVec as unknown as { load: (db: unknown) => void }).load(db);
    initSchema(db as unknown as Parameters<typeof initSchema>[0], EMBEDDING_DIM);
    // Replace the freshly created messages table with the legacy one
    db.exec("DROP INDEX IF EXISTS idx_messages_model");
    db.exec("DROP TABLE messages");
    db.exec(LEGACY_MESSAGES_DDL);
    db.exec("CREATE INDEX idx_messages_session ON messages(session_id)");
    db.exec("CREATE INDEX idx_messages_role ON messages(role)");
    db.exec("CREATE INDEX idx_messages_created ON messages(created_at)");
    const ins = db.prepare(`INSERT INTO messages (id, session_id, role, created_at, text_length, part_count, tool_call_count, message_order, indexed_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i <= indexedUpTo; i++) {
      const m = messages[i];
      ins.run(m.info.id, sessionId, m.info.role, m.info.time?.created ?? null, 0, m.parts.length, 0, i, 1);
    }
    upsertSessionMeta(db as unknown as Parameters<typeof upsertSessionMeta>[0], {
      session_id: sessionId, session_title: "legacy", project: "/p", source: "claude-code",
      last_indexed_message_id: messages[indexedUpTo].info.id, updated_at: 1, transcript_path: CLAUDE_FIXTURE,
    });
    db.close();
  }

  it("adds the columns on open and fills them in for the whole session when the conversation continues", async () => {
    const dbPath = path.join(makeTempDir(), "legacy.db");
    const messages = parseTranscript(CLAUDE_FIXTURE);
    const sessionId = MANIFEST.claude_session_id;
    const indexedUpTo = messages.length - 3; // the last two messages are "new"
    createLegacyDb(dbPath, sessionId, messages, indexedUpTo);

    // Sanity: legacy table has no model column
    const before = new Database(dbPath, { readonly: true });
    const legacyCols = (before.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
    before.close();
    expect(legacyCols).not.toContain("model");

    // Opening with the new version migrates the schema in place
    const db = openDatabase({ dbPath });
    const cols = (db.prepare("PRAGMA table_info(messages)").all() as { name: string }[]).map((c) => c.name);
    db.close();
    for (const c of ["turn_index", "model", "provider", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens", "cost"]) {
      expect(cols).toContain(c);
    }
    // Old rows have no model yet
    expect(readMessageRows(dbPath, sessionId).every((r) => r.model === null)).toBe(true);

    // The conversation continues: only the new messages are embedded, but every
    // row of the session gets its model/token columns via the upsert.
    const result = await indexNewMessages({ id: sessionId, title: "t", directory: "/p" }, messages, "claude-code", { dbPath });
    expect(result.indexed).toBe(2);
    expect(result.skipped).toBe(messages.length - 2);

    const rows = readMessageRows(dbPath, sessionId);
    expect(rows.length).toBe(messages.length);
    const assistants = rows.filter((r) => r.role === "assistant");
    expect(assistants.every((r) => r.model !== null && r.output_tokens !== null)).toBe(true);
    // indexed_at of pre-existing rows is preserved by the upsert
    expect(rows[0].indexed_at).toBe(1);
  });

  it("backfill-analytics fills sessions that are never continued, without embedding", async () => {
    const dbPath = path.join(makeTempDir(), "legacy.db");
    const messages = parseTranscript(CLAUDE_FIXTURE);
    const sessionId = MANIFEST.claude_session_id;
    createLegacyDb(dbPath, sessionId, messages, messages.length - 1); // fully indexed, old columns

    const provider = new SqliteDatabaseProvider({ dbPath });
    try {
      // An OpenCode session whose data is gone from the OpenCode DB is skipped, not failed
      await provider.upsertSessionMeta({
        session_id: "ses_gone", session_title: "gone", project: "/p", source: "opencode",
        last_indexed_message_id: "x", updated_at: 1,
      });
      // Unsupported sources are ignored entirely
      await provider.upsertSessionMeta({
        session_id: "cursor_1", session_title: "c", project: "/p", source: "cursor",
        last_indexed_message_id: "x", updated_at: 1,
      });
      // A Codex session is re-read from its rollout file (fixture has no usage → rows, but no model)
      await provider.upsertSessionMeta({
        session_id: "codex_1", session_title: "cx", project: "/p", source: "codex",
        last_indexed_message_id: "x", updated_at: 1, transcript_path: path.join(FIXTURES, "codex-session.jsonl"),
      });

      const dry = await backfillAnalytics(provider, { dryRun: true });
      expect(dry.total).toBe(3);
      expect(dry.updated).toBe(2);
      expect(dry.skipped).toBe(1);
      expect((await provider.getModelStats()).length).toBe(0); // dry run wrote nothing

      const report = await backfillAnalytics(provider);
      expect(report.updated).toBe(2);
      expect(report.results.find((r) => r.sessionId === "codex_1")?.messagesWithModel).toBe(0);
      expect(report.results.find((r) => r.sessionId === sessionId)?.messagesWithModel).toBe(
        messages.filter((m) => m.info.role === "assistant").length,
      );

      const stats = await provider.getModelStats();
      expect(stats.length).toBeGreaterThan(0);
      expect(stats.reduce((a, s) => a + s.message_count, 0)).toBe(messages.filter((m) => m.info.role === "assistant").length);

      // Restricting to a source that has nothing to do
      const none = await backfillAnalytics(provider, { sources: ["opencode"] });
      expect(none.total).toBe(1);
      expect(none.updated).toBe(0);
      // Codex only
      const codexOnly = await backfillAnalytics(provider, { sources: ["codex"] });
      expect(codexOnly.total).toBe(1);
      expect(codexOnly.updated).toBe(1);
    } finally {
      await provider.close();
    }
  });
});
