import { describe, it, expect } from "vitest";
import { sessionToMarkdown, messageToMarkdown } from "../src/session-to-md";
import type { SessionInfo, FullMessage } from "../src/types";

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "ses_abc123",
    title: "Build a REST API",
    directory: "/home/user/myapi",
    ...overrides,
  };
}

function makeUserMessage(text: string, id = "msg_u001"): FullMessage {
  return {
    info: {
      id,
      role: "user",
      time: { created: 1700000000000 },
    },
    parts: [{ type: "text", text }],
  };
}

function makeAssistantMessage(
  text: string,
  id = "msg_a001",
  opts: { agent?: string; modelID?: string; duration?: number } = {},
): FullMessage {
  const created = 1700000010000;
  const completed = opts.duration ? created + opts.duration * 1000 : undefined;
  return {
    info: {
      id,
      role: "assistant",
      agent: opts.agent ?? "build",
      modelID: opts.modelID ?? "claude-sonnet-4",
      time: { created, completed },
    },
    parts: [{ type: "text", text }],
  };
}

describe("sessionToMarkdown", () => {
  it("includes session title as H1", () => {
    const md = sessionToMarkdown(makeSession(), [makeUserMessage("Hello")]);
    expect(md).toMatch(/^# Build a REST API/m);
  });

  it("includes session ID", () => {
    const md = sessionToMarkdown(makeSession(), [makeUserMessage("Hello")]);
    expect(md).toContain("ses_abc123");
  });

  it("includes project directory", () => {
    const md = sessionToMarkdown(makeSession(), [makeUserMessage("Hello")]);
    expect(md).toContain("/home/user/myapi");
  });

  it("omits project line when directory is missing", () => {
    const md = sessionToMarkdown(makeSession({ directory: undefined }), [
      makeUserMessage("Hello"),
    ]);
    expect(md).not.toContain("**Project:**");
  });

  it("uses session ID as title when title is missing", () => {
    const md = sessionToMarkdown(makeSession({ title: undefined }), [
      makeUserMessage("Hello"),
    ]);
    expect(md).toMatch(/^# ses_abc123/m);
  });

  it("renders user messages with ## User heading", () => {
    const md = sessionToMarkdown(makeSession(), [makeUserMessage("What is TypeScript?")]);
    expect(md).toContain("## User");
    expect(md).toContain("What is TypeScript?");
  });

  it("renders assistant messages with ## Assistant heading", () => {
    const md = sessionToMarkdown(makeSession(), [
      makeUserMessage("Help"),
      makeAssistantMessage("Sure!"),
    ]);
    expect(md).toContain("## Assistant");
  });

  it("includes agent, model and duration in assistant heading", () => {
    const md = sessionToMarkdown(makeSession(), [
      makeUserMessage("Help"),
      makeAssistantMessage("Sure!", "msg_a001", {
        agent: "build",
        modelID: "claude-3",
        duration: 5,
      }),
    ]);
    expect(md).toContain("build");
    expect(md).toContain("claude-3");
    expect(md).toContain("5.0s");
  });

  it("renders tool invocation parts", () => {
    const msg: FullMessage = {
      info: { id: "msg_a001", role: "assistant", time: { created: 1700000000000 } },
      parts: [
        {
          type: "tool-invocation",
          toolName: "bash",
          state: "result",
          args: { command: "npm test" },
          result: "All tests passed",
        },
      ],
    };
    const md = sessionToMarkdown(makeSession(), [makeUserMessage("Run tests"), msg]);
    expect(md).toContain("**Tool: bash**");
    expect(md).toContain("npm test");
    expect(md).toContain("All tests passed");
  });

  it("renders file parts", () => {
    const msg: FullMessage = {
      info: { id: "msg_a001", role: "assistant", time: { created: 1700000000000 } },
      parts: [{ type: "file", filename: "src/index.ts" }],
    };
    const md = sessionToMarkdown(makeSession(), [makeUserMessage("Check"), msg]);
    expect(md).toContain("src/index.ts");
  });

  it("skips step-start parts", () => {
    const msg: FullMessage = {
      info: { id: "msg_a001", role: "assistant", time: { created: 1700000000000 } },
      parts: [
        { type: "step-start" },
        { type: "text", text: "Hello world" },
      ],
    };
    const md = sessionToMarkdown(makeSession(), [makeUserMessage("Hi"), msg]);
    expect(md).toContain("Hello world");
    expect(md).not.toContain("step-start");
  });

  it("handles empty messages array", () => {
    const md = sessionToMarkdown(makeSession(), []);
    expect(md).toContain("ses_abc123");
    // No message content
    expect(md).not.toContain("## User");
  });

  it("separates multiple messages with ---", () => {
    const md = sessionToMarkdown(makeSession(), [
      makeUserMessage("First"),
      makeAssistantMessage("Second"),
      makeUserMessage("Third", "msg_u002"),
    ]);
    expect(md).toContain("---");
  });
});

describe("messageToMarkdown", () => {
  it("renders a user message", () => {
    const md = messageToMarkdown(makeUserMessage("Hello world"));
    expect(md).toContain("## User");
    expect(md).toContain("Hello world");
  });

  it("renders an assistant message with tool call", () => {
    const msg: FullMessage = {
      info: { id: "msg_a001", role: "assistant", agent: "build", time: {} },
      parts: [
        {
          type: "tool-invocation",
          toolName: "write",
          state: "result",
          args: { filePath: "foo.ts", content: "const x = 1" },
          result: "File written",
        },
        { type: "text", text: "Done!" },
      ],
    };
    const md = messageToMarkdown(msg);
    expect(md).toContain("**Tool: write**");
    expect(md).toContain("foo.ts");
    expect(md).toContain("Done!");
  });

  it("returns empty string for message with no renderable parts", () => {
    const msg: FullMessage = {
      info: { id: "msg_a001", role: "assistant", time: {} },
      parts: [{ type: "step-start" }, { type: "step-finish" }],
    };
    expect(messageToMarkdown(msg).trim()).toBe("");
  });

  it("formats tool result as code block when result is a string", () => {
    const msg: FullMessage = {
      info: { id: "msg_a001", role: "assistant", time: {} },
      parts: [
        {
          type: "tool-invocation",
          toolName: "bash",
          state: "result",
          args: { command: "ls" },
          result: "file1.ts\nfile2.ts",
        },
      ],
    };
    const md = messageToMarkdown(msg);
    expect(md).toContain("```");
    expect(md).toContain("file1.ts");
  });

  it("formats tool result as JSON when result is an object", () => {
    const msg: FullMessage = {
      info: { id: "msg_a001", role: "assistant", time: {} },
      parts: [
        {
          type: "tool-invocation",
          toolName: "read",
          state: "result",
          args: { filePath: "foo.ts" },
          result: { type: "raw", content: "const x = 1" },
        },
      ],
    };
    const md = messageToMarkdown(msg);
    expect(md).toContain("const x = 1");
  });
});
