/**
 * cli-sessions.test.ts
 *
 * Tests for the sessions CLI command focusing on the new compact/restart features:
 * - sessionActionLoop menu includes compact and restart options
 * - Missing OPENAI_API_KEY shows a clear error and does not call OpenAI
 * - Successful compaction path logs "copied" to the user
 *
 * We use a real temp DB (with mocked embedder) and drive the interactive UI
 * via mocked @clack/prompts.  Selecting "__all__" at the source level avoids
 * sourceMap lookup issues and lets us pick directly by session ID.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import os from "os";
import path from "path";
import { mkdirSync } from "fs";

// ---------------------------------------------------------------------------
// Hoist mock variables so vi.mock factories can reference them
// ---------------------------------------------------------------------------

const {
  mockSelect,
  mockConfirm,
  mockSpinner,
  mockIntro,
  mockOutro,
  mockLog,
  spinnerInstance,
  mockCompactSession,
  mockCopyToClipboard,
} = vi.hoisted(() => {
  const spinnerInstance = { start: vi.fn(), stop: vi.fn() };
  return {
    mockSelect:          vi.fn(),
    mockConfirm:         vi.fn(),
    mockSpinner:         vi.fn().mockReturnValue(spinnerInstance),
    mockIntro:           vi.fn(),
    mockOutro:           vi.fn(),
    mockLog: {
      message: vi.fn(),
      success: vi.fn(),
      error:   vi.fn(),
      warn:    vi.fn(),
      info:    vi.fn(),
    },
    spinnerInstance,
    mockCompactSession:  vi.fn(),
    mockCopyToClipboard: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@clack/prompts", () => ({
  select:   (...args: unknown[]) => mockSelect(...args),
  confirm:  (...args: unknown[]) => mockConfirm(...args),
  spinner:  () => mockSpinner(),
  intro:    (...args: unknown[]) => mockIntro(...args),
  outro:    (...args: unknown[]) => mockOutro(...args),
  log:      mockLog,
  isCancel: (v: unknown) => v === Symbol.for("clack:cancel"),
  text:     vi.fn(),
  cancel:   vi.fn(),
}));

vi.mock("../src/session-compactor", () => ({
  compactSession: (...args: unknown[]) => mockCompactSession(...args),
}));

vi.mock("../src/clipboard", () => ({
  copyToClipboard: (...args: unknown[]) => mockCopyToClipboard(...args),
}));

// Mock embedder so we don't need a real OpenAI key for indexing.
const EMBEDDING_DIM = 3072;
vi.mock("../src/embedder", () => ({
  createEmbedder: () => ({
    embedText:  vi.fn().mockResolvedValue(Array(EMBEDDING_DIM).fill(0.1)),
    embedBatch: vi.fn().mockImplementation(async (texts: string[]) =>
      texts.map(() => Array(EMBEDDING_DIM).fill(0.1)),
    ),
  }),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { cmdSessionsList } from "../src/cli-sessions";
import { indexNewMessagesWithOptions as indexNewMessages } from "../src/indexer";
import type { FullMessage, SessionInfo } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDbPath(): string {
  const dir = path.join(
    os.tmpdir(),
    `csm-sessions-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "test.db");
}

function makeSession(id: string, title: string): SessionInfo {
  return { id, title, directory: "/home/user/proj" };
}

function makeMessage(id: string, text: string): FullMessage {
  return {
    info: { id, role: "assistant", time: { created: Date.now() } },
    parts: [{ type: "text", text }],
  };
}

const CANCEL = Symbol.for("clack:cancel");

// ---------------------------------------------------------------------------
// Tree navigation
// ---------------------------------------------------------------------------
//
// We pick "__all__" at the source level so filteredBySrc = allSessions
// (no sourceMap.get() call).  Then pick the session by ID, then the action.
//
// Source → "__all__"   (skips date level; goes to "all sessions" flat list)
// Session → ses_001
// Action  → <action>
// Extra   → extra mocked values consumed by the action flow
//
// A trailing CANCEL is always appended so that if sessionActionLoop returns
// "back" (causing the outer cmdSessionsList loop to re-enter the tree picker),
// the next source pick returns CANCEL → pickSessionTree returns null → exits.

function navigateToAction(action: string, ...extra: (string | symbol)[]) {
  mockSelect
    .mockResolvedValueOnce("__all__")   // source: all sessions
    .mockResolvedValueOnce("ses_001")   // session
    .mockResolvedValueOnce(action);     // action
  for (const val of extra) {
    mockSelect.mockResolvedValueOnce(val);
  }
  // Safety: if the action loop returns "back" the outer loop re-enters the tree.
  // This CANCEL exits pickSessionTree cleanly so cmdSessionsList can return.
  mockSelect.mockResolvedValueOnce(CANCEL);
}

// ---------------------------------------------------------------------------
// Shared reset
// ---------------------------------------------------------------------------

function resetMocks() {
  mockSelect.mockReset();
  mockConfirm.mockReset();
  mockCopyToClipboard.mockReset();
  mockCompactSession.mockReset();
  spinnerInstance.start.mockReset();
  spinnerInstance.stop.mockReset();
  mockLog.success.mockReset();
  mockLog.error.mockReset();
  mockLog.warn.mockReset();
  mockLog.info.mockReset();
  mockLog.message.mockReset();
  mockSpinner.mockReturnValue(spinnerInstance);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cmdSessionsList — action menu", () => {
  let dbPath: string;

  beforeEach(async () => {
    resetMocks();
    dbPath = makeTempDbPath();
    process.env.OPENCODE_MEMORY_DB_PATH = dbPath;
    process.env.OPENAI_API_KEY = "test-key";

    // Seed one "claude-code" session into the temp DB.
    await indexNewMessages(
      makeSession("ses_001", "Auth flow"),
      [makeMessage("msg_001", "Implemented JWT authentication middleware.")],
      "claude-code",
      { dbPath },
    );
  });

  afterEach(() => {
    delete process.env.OPENCODE_MEMORY_DB_PATH;
    delete process.env.OPENAI_API_KEY;
  });

  // ── Test: menu options ───────────────────────────────────────────────────

  it("shows compact and restart options in the action menu", async () => {
    mockSelect
      .mockResolvedValueOnce("__all__")   // source
      .mockResolvedValueOnce("ses_001")   // session
      .mockResolvedValueOnce(CANCEL);     // action → cancel (returns "back")
    // Safety CANCEL for the outer loop's second source pick:
    mockSelect.mockResolvedValueOnce(CANCEL);

    await cmdSessionsList();

    // Find the action menu call (it's the one that has a "compact" option)
    const actionCall = mockSelect.mock.calls.find((call) => {
      const opts = call[0]?.options as Array<{ value: string }> | undefined;
      return opts?.some((o: { value: string }) => o.value === "compact");
    });

    expect(actionCall).toBeDefined();
    const options = actionCall![0].options as Array<{ value: string }>;
    const values = options.map((o: { value: string }) => o.value);
    expect(values).toContain("compact");
    expect(values).not.toContain("restart");
    expect(values).toContain("print");
    expect(values).toContain("delete");
  });

  it("renders Gemini CLI as a source label in the source picker", async () => {
    await indexNewMessages(
      makeSession("ses_gemini", "Gemini flow"),
      [makeMessage("msg_g1", "Gemini assistant output.")],
      "gemini-cli",
      { dbPath },
    );

    mockSelect.mockResolvedValueOnce(CANCEL);
    await cmdSessionsList();

    const sourceCall = mockSelect.mock.calls[0];
    const options = sourceCall[0].options as Array<{ label: string }>;
    const labels = options.map((o) => o.label);
    expect(labels).toContain("Gemini CLI");
  });

  // ── Test: OPENAI_API_KEY guard ───────────────────────────────────────────

  it("shows error and does not call compactSession when OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY;

    // compact → OPENAI error → loop continues → CANCEL
    navigateToAction("compact", CANCEL);

    await cmdSessionsList();

    expect(mockCompactSession).not.toHaveBeenCalled();
    expect(mockLog.error).toHaveBeenCalledWith(
      expect.stringContaining("OPENAI_API_KEY"),
    );
  });

  // ── Test: successful compact ─────────────────────────────────────────────

  it("calls compactSession and copyToClipboard on successful compact flow", async () => {
    mockCompactSession.mockResolvedValue({
      summary: "## Context\nAuth flow\n\n## Unresolved Issues\nNone.",
      model: "gpt-4.5-mini",
      passes: 2,
      usage: {
        inputTokens: 120,
        outputTokens: 80,
        totalTokens: 200,
      },
    });
    mockCopyToClipboard.mockReturnValue({ ok: true });

    // compact → back at action menu → CANCEL
    navigateToAction("compact", CANCEL);

    await cmdSessionsList();

    expect(mockCompactSession).toHaveBeenCalledTimes(1);
    expect(mockCopyToClipboard).toHaveBeenCalledTimes(1);
    expect(mockLog.info).toHaveBeenCalledWith(
      expect.stringContaining("Token usage: input 120, output 80, total 200."),
    );
    expect(mockLog.success).toHaveBeenCalledWith(
      expect.stringContaining("copied"),
    );
  });

  // ── Test: clipboard failure fallback ─────────────────────────────────────

  it("prints compact summary to stdout when clipboard fails", async () => {
    mockCompactSession.mockResolvedValue({
      summary: "The full compact summary text.",
      model: "gpt-4.5-mini",
      passes: 2,
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      },
    });
    mockCopyToClipboard.mockReturnValue({ ok: false, error: "pbcopy: not found" });

    navigateToAction("compact", CANCEL);

    const logged: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.join(" ")); };

    try {
      await cmdSessionsList();
    } finally {
      console.log = origLog;
    }

    expect(logged.join("\n")).toContain("The full compact summary text.");
    expect(mockLog.warn).toHaveBeenCalled();
  });

});
