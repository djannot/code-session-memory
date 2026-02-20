import { describe, it, expect } from "vitest";
import path from "path";
import { cursorTranscriptToMessages } from "../src/cursor-transcript-to-messages";

const FIXTURE = path.join(__dirname, "fixtures", "cursor-transcript.jsonl");
const COMPOSER_ID = "test-composer-abc";

describe("cursorTranscriptToMessages", () => {
  it("returns one FullMessage per non-empty line", () => {
    const msgs = cursorTranscriptToMessages(FIXTURE, COMPOSER_ID);
    expect(msgs).toHaveLength(5);
  });

  it("assigns stable IDs based on composerId and line index", () => {
    const msgs = cursorTranscriptToMessages(FIXTURE, COMPOSER_ID);
    expect(msgs[0].info.id).toBe(`${COMPOSER_ID}-0`);
    expect(msgs[1].info.id).toBe(`${COMPOSER_ID}-1`);
    expect(msgs[4].info.id).toBe(`${COMPOSER_ID}-4`);
  });

  it("sets role correctly", () => {
    const msgs = cursorTranscriptToMessages(FIXTURE, COMPOSER_ID);
    expect(msgs[0].info.role).toBe("user");
    expect(msgs[1].info.role).toBe("assistant");
    expect(msgs[3].info.role).toBe("user");
    expect(msgs[4].info.role).toBe("assistant");
  });

  it("strips <user_query> wrapper tags from user messages", () => {
    const msgs = cursorTranscriptToMessages(FIXTURE, COMPOSER_ID);
    expect(msgs[0].parts[0]).toMatchObject({ type: "text", text: "Read a file" });
    expect(msgs[3].parts[0]).toMatchObject({ type: "text", text: "Read another one" });
  });

  it("preserves assistant message text verbatim", () => {
    const msgs = cursorTranscriptToMessages(FIXTURE, COMPOSER_ID);
    expect(msgs[1].parts[0]).toMatchObject({ type: "text", text: "Checking the project structure." });
  });

  it("returns empty array for a non-existent file", () => {
    const msgs = cursorTranscriptToMessages("/does/not/exist.jsonl", COMPOSER_ID);
    expect(msgs).toHaveLength(0);
  });

  it("each message has exactly one text part", () => {
    const msgs = cursorTranscriptToMessages(FIXTURE, COMPOSER_ID);
    for (const msg of msgs) {
      expect(msg.parts).toHaveLength(1);
      expect(msg.parts[0].type).toBe("text");
    }
  });
});
