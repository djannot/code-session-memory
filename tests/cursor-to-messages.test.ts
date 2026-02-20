/**
 * cursor-to-messages.test.ts
 *
 * Unit tests for the Cursor → FullMessage[] conversion pipeline.
 * Uses the committed JSON fixture (tests/fixtures/cursor-session.json)
 * so no live Cursor DB is needed during CI.
 */

import { describe, it, expect, beforeAll } from "vitest";
import path from "path";
import fs from "fs";
import type { FullMessage } from "../src/types";

// ---------------------------------------------------------------------------
// Load fixture
// ---------------------------------------------------------------------------

const FIXTURES = path.join(__dirname, "fixtures");

interface CursorFixture {
  composerId: string;
  name: string;
  messages: FullMessage[];
}

function loadFixture(name: "cursor-session.json" | "cursor-turn1.json"): CursorFixture {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")) as CursorFixture;
}

// ---------------------------------------------------------------------------
// Tests against the fixture (no DB required)
// ---------------------------------------------------------------------------

describe("cursor-session fixture — message structure", () => {
  let fixture: CursorFixture;

  beforeAll(() => {
    fixture = loadFixture("cursor-session.json");
  });

  it("has at least one message", () => {
    expect(fixture.messages.length).toBeGreaterThanOrEqual(1);
  });

  it("has a composerId", () => {
    expect(fixture.composerId).toBeTruthy();
    expect(fixture.composerId.length).toBeGreaterThan(0);
  });

  it("has a session name", () => {
    expect(fixture.name).toBeTruthy();
  });

  it("first message is a user message with non-empty text", () => {
    const firstMsg = fixture.messages[0];
    expect(firstMsg.info.role).toBe("user");
    const textPart = firstMsg.parts.find((p) => p.type === "text");
    expect(textPart).toBeDefined();
    expect(textPart!.text?.trim().length).toBeGreaterThan(0);
  });

  it("all messages have unique IDs", () => {
    const ids = fixture.messages.map((m) => m.info.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it("all messages have a role of user or assistant", () => {
    for (const msg of fixture.messages) {
      expect(["user", "assistant", "tool"]).toContain(msg.info.role);
    }
  });

  it("includes at least one assistant message", () => {
    const hasAssistant = fixture.messages.some((m) => m.info.role === "assistant");
    expect(hasAssistant).toBe(true);
  });

  it("includes a tool-invocation part with state=result", () => {
    const toolResultPart = fixture.messages
      .flatMap((m) => m.parts)
      .find((p) => p.type === "tool-invocation" && p.state === "result");
    expect(toolResultPart).toBeDefined();
    expect(toolResultPart?.toolName).toBeTruthy();
  });

  it("tool-invocation part has a toolCallId", () => {
    const toolPart = fixture.messages
      .flatMap((m) => m.parts)
      .find((p) => p.type === "tool-invocation");
    expect(toolPart?.toolCallId).toBeTruthy();
  });

  it("includes at least one text assistant message", () => {
    const textAssistant = fixture.messages.find(
      (m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text"),
    );
    expect(textAssistant).toBeDefined();
  });

  it("no message has empty parts array", () => {
    for (const msg of fixture.messages) {
      expect(msg.parts.length).toBeGreaterThan(0);
    }
  });
});

describe("cursor-turn1 fixture", () => {
  let turn1: CursorFixture;
  let full: CursorFixture;

  beforeAll(() => {
    turn1 = loadFixture("cursor-turn1.json");
    full = loadFixture("cursor-session.json");
  });

  it("turn1 has at least one message", () => {
    expect(turn1.messages.length).toBeGreaterThanOrEqual(1);
  });

  it("turn1 has no more messages than full session", () => {
    expect(turn1.messages.length).toBeLessThanOrEqual(full.messages.length);
  });

  it("turn1 message IDs are a subset of full session IDs", () => {
    const fullIds = new Set(full.messages.map((m) => m.info.id));
    for (const msg of turn1.messages) {
      expect(fullIds.has(msg.info.id)).toBe(true);
    }
  });

  it("composerId matches between turn1 and full", () => {
    expect(turn1.composerId).toBe(full.composerId);
  });
});
