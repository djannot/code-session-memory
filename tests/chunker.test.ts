import { describe, it, expect } from "vitest";
import { chunkMarkdown, hashContent } from "../src/chunker";

const BASE_OPTS = {
  sessionId: "ses_test123",
  sessionTitle: "Test Session",
  project: "/home/user/myproject",
  baseUrl: "session://ses_test123#msg_001",
};

describe("hashContent", () => {
  it("returns a 64-char hex string", () => {
    expect(hashContent("hello")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is deterministic", () => {
    expect(hashContent("hello")).toBe(hashContent("hello"));
  });

  it("differs for different inputs", () => {
    expect(hashContent("hello")).not.toBe(hashContent("world"));
  });
});

describe("chunkMarkdown", () => {
  it("returns empty array for empty markdown", () => {
    expect(chunkMarkdown("", BASE_OPTS)).toEqual([]);
  });

  it("returns empty array for whitespace-only markdown", () => {
    expect(chunkMarkdown("   \n\n   ", BASE_OPTS)).toEqual([]);
  });

  it("chunks a simple single-section document", () => {
    const md = `## User\n\nHello, can you help me write a function?`;
    const chunks = chunkMarkdown(md, BASE_OPTS);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].content).toContain("Hello, can you help me write a function?");
  });

  it("attaches correct metadata to chunks", () => {
    const md = "## User\n\nSome request here";
    const chunks = chunkMarkdown(md, BASE_OPTS);
    expect(chunks.length).toBeGreaterThan(0);
    const chunk = chunks[0];
    expect(chunk.metadata.session_id).toBe("ses_test123");
    expect(chunk.metadata.session_title).toBe("Test Session");
    expect(chunk.metadata.project).toBe("/home/user/myproject");
    expect(chunk.metadata.url).toBe("session://ses_test123#msg_001");
  });

  it("sets correct chunk_index and total_chunks", () => {
    const md = "## User\n\nSome request here";
    const chunks = chunkMarkdown(md, BASE_OPTS);
    chunks.forEach((chunk, i) => {
      expect(chunk.metadata.chunk_index).toBe(i);
      expect(chunk.metadata.total_chunks).toBe(chunks.length);
    });
  });

  it("generates unique chunk_ids across chunks", () => {
    // Long document to force multiple chunks
    const section = (title: string) =>
      `## ${title}\n\n` + "word ".repeat(200) + "\n\n";
    const md = section("A") + section("B") + section("C") + section("D") + section("E");
    const chunks = chunkMarkdown(md, BASE_OPTS);
    const ids = chunks.map((c) => c.metadata.chunk_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("produces stable chunk_ids (same input → same id)", () => {
    const md = "## Section\n\nSome content here";
    const a = chunkMarkdown(md, BASE_OPTS);
    const b = chunkMarkdown(md, BASE_OPTS);
    expect(a.map((c) => c.metadata.chunk_id)).toEqual(
      b.map((c) => c.metadata.chunk_id),
    );
  });

  it("prepends breadcrumb prefix to content", () => {
    const md = "# Title\n\n## Sub\n\nContent here";
    const chunks = chunkMarkdown(md, BASE_OPTS);
    // At least one chunk should have a [Session: ...] prefix
    const hasBreadcrumb = chunks.some((c) => c.content.startsWith("[Session:"));
    expect(hasBreadcrumb).toBe(true);
  });

  it("handles nested headings in hierarchy", () => {
    const md = "# Root\n\n## Child\n\n### Grandchild\n\nDeep content here";
    const chunks = chunkMarkdown(md, BASE_OPTS);
    expect(chunks.length).toBeGreaterThan(0);
    // heading_hierarchy should reflect the nesting
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.metadata.heading_hierarchy.length).toBeGreaterThan(0);
  });

  it("splits oversized sections (>1000 tokens) with overlap", () => {
    // ~1200 words — should produce at least 2 chunks
    const bigContent = "word ".repeat(1200);
    const md = `## Big Section\n\n${bigContent}`;
    const chunks = chunkMarkdown(md, BASE_OPTS);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("merges tiny sections below MIN_TOKENS (150)", () => {
    // Two tiny sections — should be merged into one chunk
    const md = [
      "## Section A",
      "Short content A.",
      "",
      "## Section B",
      "Short content B.",
    ].join("\n");
    const chunks = chunkMarkdown(md, BASE_OPTS);
    // With tiny content, both sections should end up in a small number of chunks
    expect(chunks.length).toBeLessThanOrEqual(2);
  });

  it("uses different baseUrl for url metadata", () => {
    const opts = { ...BASE_OPTS, baseUrl: "session://ses_abc#msg_xyz" };
    const chunks = chunkMarkdown("## User\n\nHello world", opts);
    chunks.forEach((c) => {
      expect(c.metadata.url).toBe("session://ses_abc#msg_xyz");
    });
  });
});
