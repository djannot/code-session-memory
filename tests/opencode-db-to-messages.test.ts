import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import os from "os";
import path from "path";
import fs from "fs";
import { getSessionFromOpenCodeDb, getMessagesFromOpenCodeDb } from "../src/opencode-db-to-messages";

// ---------------------------------------------------------------------------
// Helpers: create a minimal in-memory OpenCode DB fixture
// ---------------------------------------------------------------------------

function createTestOpenCodeDb(dbPath: string) {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      parent_id TEXT,
      slug TEXT NOT NULL,
      directory TEXT NOT NULL,
      title TEXT NOT NULL,
      version TEXT NOT NULL,
      share_url TEXT,
      summary_additions INTEGER,
      summary_deletions INTEGER,
      summary_files INTEGER,
      summary_diffs TEXT,
      revert TEXT,
      permission TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      time_compacting INTEGER,
      time_archived INTEGER
    );

    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );

    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);

  // Insert a test session
  db.prepare(`
    INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("ses_test_001", "proj_001", "test-session", "/home/user/project", "Test Session", "1.0.0", 1000, 2000);

  // Insert a user message with a text part
  db.prepare(`
    INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?)
  `).run("msg_001", "ses_test_001", 1001, 1002, JSON.stringify({ role: "user", time: { created: 1001 }, agent: "build" }));

  db.prepare(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("prt_001", "msg_001", "ses_test_001", 1001, 1002, JSON.stringify({ type: "text", text: "Hello world" }));

  // Insert an assistant message with step-start, text, step-finish parts
  db.prepare(`
    INSERT INTO message (id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?)
  `).run("msg_002", "ses_test_001", 1003, 1010, JSON.stringify({
    role: "assistant",
    time: { created: 1003, completed: 1010 },
    agent: "build",
    modelID: "claude-sonnet-4-6@default",
  }));

  db.prepare(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("prt_002a", "msg_002", "ses_test_001", 1003, 1003, JSON.stringify({ type: "step-start" }));

  db.prepare(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("prt_002b", "msg_002", "ses_test_001", 1004, 1009, JSON.stringify({ type: "text", text: "Hi there!" }));

  db.prepare(`
    INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run("prt_002c", "msg_002", "ses_test_001", 1010, 1010, JSON.stringify({ type: "step-finish" }));

  db.close();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getSessionFromOpenCodeDb", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `opencode-test-${Math.random().toString(36).slice(2)}.db`);
    createTestOpenCodeDb(dbPath);
  });

  afterEach(() => {
    fs.rmSync(dbPath, { force: true });
  });

  it("returns session metadata for a known session", () => {
    const session = getSessionFromOpenCodeDb("ses_test_001", dbPath);
    expect(session).not.toBeNull();
    expect(session!.id).toBe("ses_test_001");
    expect(session!.title).toBe("Test Session");
    expect(session!.directory).toBe("/home/user/project");
  });

  it("returns null for an unknown session", () => {
    const session = getSessionFromOpenCodeDb("ses_unknown", dbPath);
    expect(session).toBeNull();
  });

  it("returns null when DB does not exist", () => {
    const session = getSessionFromOpenCodeDb("ses_test_001", "/nonexistent/path.db");
    expect(session).toBeNull();
  });
});

describe("getMessagesFromOpenCodeDb", () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `opencode-test-${Math.random().toString(36).slice(2)}.db`);
    createTestOpenCodeDb(dbPath);
  });

  afterEach(() => {
    fs.rmSync(dbPath, { force: true });
  });

  it("returns messages in chronological order", () => {
    const messages = getMessagesFromOpenCodeDb("ses_test_001", dbPath);
    expect(messages).not.toBeNull();
    expect(messages!).toHaveLength(2);
    expect(messages![0].info.id).toBe("msg_001");
    expect(messages![1].info.id).toBe("msg_002");
  });

  it("shapes message info correctly", () => {
    const messages = getMessagesFromOpenCodeDb("ses_test_001", dbPath);
    const user = messages![0];
    expect(user.info.role).toBe("user");
    expect(user.info.agent).toBe("build");

    const asst = messages![1];
    expect(asst.info.role).toBe("assistant");
    expect(asst.info.modelID).toBe("claude-sonnet-4-6@default");
    expect(asst.info.time?.completed).toBe(1010);
  });

  it("attaches parts to each message in order", () => {
    const messages = getMessagesFromOpenCodeDb("ses_test_001", dbPath);
    const user = messages![0];
    expect(user.parts).toHaveLength(1);
    expect(user.parts[0].type).toBe("text");
    expect(user.parts[0].text).toBe("Hello world");

    const asst = messages![1];
    expect(asst.parts).toHaveLength(3);
    expect(asst.parts.map((p) => p.type)).toEqual(["step-start", "text", "step-finish"]);
    expect(asst.parts[1].text).toBe("Hi there!");
  });

  it("returns empty array for a session with no messages", () => {
    const messages = getMessagesFromOpenCodeDb("ses_unknown", dbPath);
    expect(messages).toEqual([]);
  });

  it("returns null when DB does not exist", () => {
    const messages = getMessagesFromOpenCodeDb("ses_test_001", "/nonexistent/path.db");
    expect(messages).toBeNull();
  });
});
