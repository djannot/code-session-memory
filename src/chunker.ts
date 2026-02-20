import crypto from "crypto";
import type { DocumentChunk } from "./types";

// ---------------------------------------------------------------------------
// Constants (matching doc2vec defaults)
// ---------------------------------------------------------------------------
const MAX_TOKENS = 1000;
const MIN_TOKENS = 150;
const OVERLAP_PERCENT = 0.1;

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

// ---------------------------------------------------------------------------
// Chunk creation
// ---------------------------------------------------------------------------

export interface ChunkOptions {
  sessionId: string;
  sessionTitle: string;
  project: string;
  /** Base URL for the message, e.g. "session://ses_xxx#msg_yyy" */
  baseUrl: string;
}

function countTokens(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function buildBreadcrumb(headingHierarchy: string[]): string {
  return headingHierarchy.filter(Boolean).join(" > ");
}

/**
 * Splits an oversized buffer into overlapping sub-chunks.
 */
function splitWithOverlap(lines: string[]): string[][] {
  const words = lines.join("\n").split(/\s+/).filter(Boolean);
  const overlapCount = Math.floor(MAX_TOKENS * OVERLAP_PERCENT);
  const chunks: string[][] = [];
  let start = 0;

  while (start < words.length) {
    const end = Math.min(start + MAX_TOKENS, words.length);
    chunks.push(words.slice(start, end));
    if (end >= words.length) break;
    start = end - overlapCount;
  }

  return chunks;
}

function createChunk(
  content: string,
  headingHierarchy: string[],
  chunkIndex: number,
  options: ChunkOptions,
): Omit<DocumentChunk, "metadata"> & { metadata: Omit<DocumentChunk["metadata"], "total_chunks"> } {
  const breadcrumb = buildBreadcrumb(headingHierarchy);
  const prefixedContent = breadcrumb
    ? `[Session: ${breadcrumb}]\n\n${content}`
    : content;
  const hash = hashContent(prefixedContent);
  const chunkId = hashContent(`${options.baseUrl}::${chunkIndex}::${prefixedContent}`);

  return {
    content: prefixedContent,
    metadata: {
      session_id: options.sessionId,
      session_title: options.sessionTitle,
      project: options.project,
      heading_hierarchy: headingHierarchy,
      section: headingHierarchy[headingHierarchy.length - 1] ?? "",
      chunk_id: chunkId,
      url: options.baseUrl,
      hash,
      chunk_index: chunkIndex,
    },
  };
}

// ---------------------------------------------------------------------------
// Main chunker
// ---------------------------------------------------------------------------

/**
 * Splits a markdown string into semantically meaningful, heading-aware chunks.
 * Adapted from doc2vec's ContentProcessor.chunkMarkdown().
 *
 * @param markdown   Full markdown text to chunk
 * @param options    Metadata to attach to each chunk
 */
export function chunkMarkdown(
  markdown: string,
  options: ChunkOptions,
): DocumentChunk[] {
  const lines = markdown.split("\n");
  const headingHierarchy: string[] = [];
  let buffer: string[] = [];
  const pendingChunks: Array<{ lines: string[]; hierarchy: string[] }> = [];

  function flushBuffer(hierarchy: string[]): void {
    if (buffer.length === 0) return;
    const tokenCount = countTokens(buffer.join("\n"));

    if (tokenCount > MAX_TOKENS) {
      // Split with overlap
      const subChunks = splitWithOverlap(buffer);
      for (const wordBatch of subChunks) {
        pendingChunks.push({
          lines: [wordBatch.join(" ")],
          hierarchy: [...hierarchy],
        });
      }
    } else {
      pendingChunks.push({ lines: [...buffer], hierarchy: [...hierarchy] });
    }
    buffer = [];
  }

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);

    if (headingMatch) {
      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();

      // Flush before updating the heading stack
      const tokenCount = countTokens(buffer.join("\n"));
      if (tokenCount >= MIN_TOKENS) {
        flushBuffer([...headingHierarchy]);
      } else if (buffer.length > 0) {
        // Merge small buffer into next section
        // keep it in buffer
      }

      // Update heading hierarchy
      headingHierarchy[level - 1] = title;
      // Clear deeper levels
      headingHierarchy.splice(level);
    } else {
      buffer.push(line);
    }
  }

  // Flush remaining
  flushBuffer([...headingHierarchy]);

  // Merge tiny trailing chunks into the previous one
  const merged: Array<{ lines: string[]; hierarchy: string[] }> = [];
  for (const chunk of pendingChunks) {
    const tokens = countTokens(chunk.lines.join("\n"));
    if (tokens < MIN_TOKENS && merged.length > 0) {
      const prev = merged[merged.length - 1];
      prev.lines = [...prev.lines, "", ...chunk.lines];
    } else {
      merged.push(chunk);
    }
  }

  // Filter out empty/whitespace-only chunks before finalizing
  const nonEmpty = merged.filter((m) => m.lines.join("\n").trim().length > 0);

  // Build final DocumentChunks with correct total_chunks
  const total = nonEmpty.length;
  return nonEmpty.map((m, idx) => {
    const partial = createChunk(m.lines.join("\n"), m.hierarchy, idx, options);
    return {
      ...partial,
      metadata: { ...partial.metadata, total_chunks: total },
    };
  });
}
