/**
 * Parses a Cursor agent transcript JSONL file into FullMessage[].
 *
 * Cursor writes the transcript to disk BEFORE firing the stop hook, so this
 * file is always complete and consistent — unlike state.vscdb which is written
 * asynchronously and may lag behind the hook by several seconds.
 *
 * Transcript format (one JSON object per line):
 *   { "role": "user" | "assistant", "message": { "content": [{ "type": "text", "text": "..." }] } }
 *
 * Message IDs are derived as "<composerId>-<lineIndex>" since the JSONL has no
 * bubble IDs. These are stable: line order never changes (only appended).
 */

import fs from "fs";
import type { FullMessage } from "./types";

// ---------------------------------------------------------------------------
// Raw JSONL shape
// ---------------------------------------------------------------------------

interface TranscriptContentPart {
  type: string;
  text?: string;
}

interface TranscriptEntry {
  role: "user" | "assistant";
  message: {
    content: TranscriptContentPart[] | string;
  };
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Reads a Cursor transcript JSONL and returns FullMessage[].
 *
 * @param transcriptPath  Absolute path to the .jsonl file
 * @param composerId      Used to derive stable per-message IDs
 */
export function cursorTranscriptToMessages(
  transcriptPath: string,
  composerId: string,
): FullMessage[] {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }

  const lines = raw.split("\n").filter((l) => l.trim());
  const messages: FullMessage[] = [];

  for (let i = 0; i < lines.length; i++) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(lines[i]) as TranscriptEntry;
    } catch {
      continue;
    }

    const { role, message } = entry;
    if (role !== "user" && role !== "assistant") continue;

    // Extract plain text from content
    const content = message?.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text!)
        .join("\n");
    }

    // Strip Cursor's <user_query> wrapper tags
    text = text
      .replace(/^<user_query>\s*/i, "")
      .replace(/\s*<\/user_query>$/i, "")
      .trim();

    if (!text) continue;

    // Stable ID: composerId + line index
    const id = `${composerId}-${i}`;

    messages.push({
      info: { id, role },
      parts: [{ type: "text", text }],
    });
  }

  return messages;
}
