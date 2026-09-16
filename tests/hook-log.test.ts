/**
 * hook-log.test.ts
 *
 * Hosts discard hook stderr, so the hook log is the only trace a failing
 * indexer leaves behind. It must therefore never throw, and must stay
 * readable (and bounded) over time.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import { getHookLogPath, logHook, logHookError, readHookLog } from "../src/hook-log";

let tempHome: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "csm-hook-log-"));
  process.env.HOME = tempHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe("hook log", () => {
  it("creates the log directory on first write", () => {
    logHook("info", "claude-code", "session abc: 3 chunk(s) indexed");
    expect(fs.existsSync(getHookLogPath())).toBe(true);
  });

  it("round-trips entries with level, source and message", () => {
    logHook("info", "claude-code", "session abc: 3 chunk(s) indexed");
    logHook("error", "cursor", "Indexing error: boom");

    const entries = readHookLog();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ level: "info", source: "claude-code" });
    expect(entries[1]).toMatchObject({
      level: "error",
      source: "cursor",
      message: "Indexing error: boom",
    });
    expect(Number.isNaN(Date.parse(entries[1].timestamp))).toBe(false);
  });

  it("filters by level and keeps only the most recent entries", () => {
    for (let i = 0; i < 5; i++) logHook("info", "codex", `run ${i}`);
    logHook("error", "codex", "failed");

    expect(readHookLog(2).map((e) => e.message)).toEqual(["run 4", "failed"]);
    expect(readHookLog(20, "error").map((e) => e.message)).toEqual(["failed"]);
  });

  it("collapses multi-line messages so one run stays one line", () => {
    logHookError("vscode", "Fatal: Error: boom\n    at someFunction\n    at main");
    const entries = readHookLog();
    expect(entries).toHaveLength(1);
    expect(entries[0].message).toBe("Fatal: Error: boom at someFunction at main");
  });

  it("rotates once the log grows past the size cap", () => {
    const logPath = getHookLogPath();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "x".repeat(1024 * 1024 + 1));

    logHook("info", "gemini-cli", "after rotation");

    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(readHookLog().map((e) => e.message)).toEqual(["after rotation"]);
  });

  it("never throws when the log cannot be written", () => {
    // A file where the log directory should be makes mkdir fail.
    fs.mkdirSync(path.join(tempHome, ".config", "code-session-memory"), { recursive: true });
    fs.writeFileSync(path.join(tempHome, ".config", "code-session-memory", "logs"), "not a dir");

    expect(() => logHook("error", "claude-code", "still fine")).not.toThrow();
    expect(readHookLog()).toEqual([]);
  });
});
