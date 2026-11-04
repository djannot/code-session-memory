import { describe, it, expect, vi } from "vitest";
import path from "path";
import os from "os";
import fs from "fs";
import { mkdirSync, writeFileSync } from "fs";

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
  antigravityTranscriptToMessages,
  deriveAntigravitySessionTitle,
  extractUserRequest,
} from "../src/antigravity-transcript-to-messages";
import { discoverAntigravityTranscript } from "../src/transcript-discovery";
import { indexNewMessagesWithOptions as indexNewMessages } from "../src/indexer";
import { openDatabase, getSessionMeta, getSessionChunksOrdered } from "../src/database";
import type { SessionInfo, FullMessage } from "../src/types";

const FIXTURE_PATH = path.join(__dirname, "fixtures", "antigravity-transcript.jsonl");
const CONVERSATION_ID = "7e340ebe-7d66-4015-9788-a9ab0b6350f9";

function makeTempDir(prefix: string): string {
  const dir = path.join(
    os.tmpdir(),
    `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTempDbPath(): string {
  return path.join(makeTempDir("csm-e2e-antigravity"), "test.db");
}

function makeSession(id = CONVERSATION_ID): SessionInfo {
  return { id, title: "Antigravity E2E Test", directory: "/test/project" };
}

describe("extractUserRequest", () => {
  it("keeps only what the user typed, dropping Antigravity's metadata blocks", () => {
    const raw =
      "<USER_REQUEST>\nFix the failing unit test\n</USER_REQUEST>\n" +
      "<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-04T12:09:57+01:00.\n</ADDITIONAL_METADATA>";
    expect(extractUserRequest(raw)).toBe("Fix the failing unit test");
  });

  it("falls back to stripping metadata when the request tag is absent", () => {
    const raw =
      "Plain prompt\n<ADDITIONAL_METADATA>\nnoise\n</ADDITIONAL_METADATA>\n" +
      "<USER_SETTINGS_CHANGE>\nmore noise\n</USER_SETTINGS_CHANGE>";
    expect(extractUserRequest(raw)).toBe("Plain prompt");
  });

  it("returns empty string for non-string content", () => {
    expect(extractUserRequest(undefined)).toBe("");
    expect(extractUserRequest({ text: "hi" })).toBe("");
  });
});

describe("antigravityTranscriptToMessages", () => {
  it("keeps user and model steps, skipping system messages and tool-result steps", () => {
    const messages = antigravityTranscriptToMessages(FIXTURE_PATH, {
      conversationId: CONVERSATION_ID,
    });

    // 1 user + 3 PLANNER_RESPONSE; GENERIC steps are merged into tool parts and
    // the SYSTEM_MESSAGE step is dropped.
    expect(messages).toHaveLength(4);
    expect(messages.map((m) => m.info.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "assistant",
    ]);

    expect(messages[0].parts).toEqual([
      { type: "text", text: "What MCP servers are configured ?" },
    ]);
  });

  it("merges the following GENERIC steps into the matching tool-invocation parts", () => {
    const messages = antigravityTranscriptToMessages(FIXTURE_PATH, {
      conversationId: CONVERSATION_ID,
    });

    const single = messages[1].parts.filter((p) => p.type === "tool-invocation");
    expect(single).toHaveLength(1);
    expect(single[0]).toMatchObject({
      toolName: "read_file",
      state: "result",
      args: { Path: "/Users/alice/.gemini/config/mcp_config.json" },
    });
    expect(single[0].result).toContain("mcpServers");

    // Two calls in one step consume the next two GENERIC steps, in order.
    const pair = messages[2].parts.filter((p) => p.type === "tool-invocation");
    expect(pair).toHaveLength(2);
    expect(pair[0]).toMatchObject({ toolName: "run_command", state: "result" });
    expect(pair[0].result).toContain("mcp_config.json");
    // A step carrying `error` becomes an error state, so analytics can count
    // failed tool calls; the message still reaches the indexed text.
    expect(pair[1]).toMatchObject({ toolName: "read_file", state: "error" });
    expect(pair[1].result).toBe("(error: file does not exist)");
  });

  it("skips internal thinking but keeps the final answer text", () => {
    const messages = antigravityTranscriptToMessages(FIXTURE_PATH, {
      conversationId: CONVERSATION_ID,
    });

    const last = messages[3];
    expect(last.parts).toHaveLength(1);
    expect(last.parts[0].type).toBe("text");
    expect(last.parts[0].text).toContain("no MCP servers configured");
    expect(JSON.stringify(last)).not.toContain("summarise");
  });

  it("records the model from the hook payload and the step token counts", () => {
    const messages = antigravityTranscriptToMessages(FIXTURE_PATH, {
      conversationId: CONVERSATION_ID,
      modelName: "gemini-4-argon",
    });

    expect(messages[1].info.modelID).toBe("gemini-4-argon");
    // input_tokens and cache_read_tokens are disjoint counts in Antigravity.
    expect(messages[1].info.tokens).toEqual({
      input: 3753,
      output: 118,
      total: 3753 + 8068 + 118,
      cache: { read: 8068, write: 0 },
    });
    expect(messages[0].info.modelID).toBeUndefined();
    expect(messages[0].info.tokens).toBeUndefined();
  });

  it("builds stable message ids from the conversation id and step index", () => {
    const messages = antigravityTranscriptToMessages(FIXTURE_PATH, {
      conversationId: CONVERSATION_ID,
    });
    expect(messages.map((m) => m.info.id)).toEqual([
      `${CONVERSATION_ID}-0`,
      `${CONVERSATION_ID}-1`,
      `${CONVERSATION_ID}-3`,
      `${CONVERSATION_ID}-7`,
    ]);
  });

  it("ignores malformed lines instead of losing the whole transcript", () => {
    const dir = makeTempDir("antigravity-partial");
    const p = path.join(dir, "transcript.jsonl");
    writeFileSync(
      p,
      [
        '{"step_index": 0, "source": "USER_EXPLICIT", "type": "USER_INPUT", "created_at": "2026-11-04T11:00:00Z", "content": "<USER_REQUEST>\\nhello\\n</USER_REQUEST>"}',
        "",
        '{"step_index": 1, "source": "MODEL", "type": "PLANNER_RE', // partially flushed line
      ].join("\n"),
      "utf8",
    );

    const messages = antigravityTranscriptToMessages(p, { conversationId: "c1" });
    expect(messages).toHaveLength(1);
    expect(messages[0].parts[0].text).toBe("hello");
  });

  it("returns no messages for a missing transcript", () => {
    expect(antigravityTranscriptToMessages("/does/not/exist.jsonl")).toEqual([]);
  });
});

describe("deriveAntigravitySessionTitle", () => {
  it("derives the title from the first user text with fallbacks", () => {
    const messages = antigravityTranscriptToMessages(FIXTURE_PATH, {
      conversationId: CONVERSATION_ID,
    });

    expect(deriveAntigravitySessionTitle(messages)).toBe("What MCP servers are configured ?");
    expect(deriveAntigravitySessionTitle([], "conv-1")).toBe("conv-1");
    expect(deriveAntigravitySessionTitle([])).toBe("Antigravity Session");
  });
});

describe("discoverAntigravityTranscript", () => {
  it("finds the transcript under any of the three Antigravity surfaces", () => {
    const geminiDir = makeTempDir("antigravity-home");
    const transcript = path.join(
      geminiDir,
      "antigravity-ide",
      "brain",
      CONVERSATION_ID,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, "", "utf8");

    const previous = process.env.GEMINI_CONFIG_DIR;
    process.env.GEMINI_CONFIG_DIR = geminiDir;
    try {
      expect(discoverAntigravityTranscript(CONVERSATION_ID)).toBe(transcript);
      expect(discoverAntigravityTranscript("unknown-conversation")).toBeNull();
      expect(discoverAntigravityTranscript("")).toBeNull();
    } finally {
      if (previous === undefined) delete process.env.GEMINI_CONFIG_DIR;
      else process.env.GEMINI_CONFIG_DIR = previous;
    }
  });
});

describe("Antigravity e2e: parse -> index -> query", () => {
  it("indexes Antigravity messages and stores source=antigravity", async () => {
    const dbPath = makeTempDbPath();
    const messages: FullMessage[] = antigravityTranscriptToMessages(FIXTURE_PATH, {
      conversationId: CONVERSATION_ID,
      modelName: "gemini-4-argon",
    });
    expect(messages.length).toBeGreaterThan(0);

    const session = makeSession();
    const result = await indexNewMessages(session, messages, "antigravity", { dbPath });
    expect(result.indexed).toBeGreaterThan(0);

    const db = openDatabase({ dbPath });
    try {
      const meta = getSessionMeta(db, CONVERSATION_ID);
      expect(meta).toBeDefined();
      expect(meta!.source).toBe("antigravity");
      expect(meta!.session_title).toBe("Antigravity E2E Test");

      const chunks = getSessionChunksOrdered(db, CONVERSATION_ID);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].content).toBeTruthy();

      const models = db
        .prepare("SELECT DISTINCT model FROM messages WHERE model IS NOT NULL")
        .all() as Array<{ model: string }>;
      expect(models.map((m) => m.model)).toContain("gemini-4-argon");

      // The failed read_file is recorded as an error, and its message still
      // made it into the indexed text.
      const errors = db
        .prepare("SELECT tool_name FROM tool_calls WHERE has_error = 1")
        .all() as Array<{ tool_name: string }>;
      expect(errors.map((e) => e.tool_name)).toEqual(["read_file"]);
      expect(chunks.map((c) => c.content).join("\n")).toContain("file does not exist");
    } finally {
      db.close();
    }
  });
});
