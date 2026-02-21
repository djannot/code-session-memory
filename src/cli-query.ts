/**
 * cli-query — `code-session-memory query <text>` command.
 *
 * Performs semantic search against the indexed sessions database using an
 * OpenAI embedding of the query text, then prints matching results to stdout.
 *
 * Usage:
 *   npx code-session-memory query "authentication middleware"
 *   npx code-session-memory query "auth flow" --source opencode
 *   npx code-session-memory query "migration" --limit 10
 *   npx code-session-memory query "error handling" --from 2026-02-01 --to 2026-02-20
 *
 * Requires OPENAI_API_KEY environment variable for embedding generation.
 */

import { resolveDbPath, openDatabase, queryByEmbedding } from "./database";
import { createEmbedder } from "./embedder";
import type { SessionSource, QueryResult } from "./types";

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

function bold(s: string): string { return `\x1b[1m${s}\x1b[0m`; }
function dim(s: string): string  { return `\x1b[2m${s}\x1b[0m`; }
function cyan(s: string): string { return `\x1b[36m${s}\x1b[0m`; }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m`; }

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface QueryOptions {
  queryText: string;
  source?: SessionSource;
  limit: number;
  fromMs?: number;
  toMs?: number;
}

/**
 * Parses `process.argv`-style args into QueryOptions.
 * The query text is everything up to the first flag (--xxx), joined with spaces.
 * Throws a descriptive error on bad input.
 */
export function parseQueryArgs(args: string[]): QueryOptions {
  const queryWords: string[] = [];
  let source: SessionSource | undefined;
  let limit = 5;
  let fromMs: number | undefined;
  let toMs: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--source") {
      const val = args[++i];
      if (!val) throw new Error("--source requires a value (opencode, claude-code, cursor)");
      if (val !== "opencode" && val !== "claude-code" && val !== "cursor") {
        throw new Error(`Invalid --source "${val}". Must be one of: opencode, claude-code, cursor`);
      }
      source = val;
    } else if (arg === "--limit") {
      const val = args[++i];
      if (!val) throw new Error("--limit requires a number");
      const n = parseInt(val, 10);
      if (isNaN(n) || n < 1) throw new Error(`Invalid --limit "${val}". Must be a positive integer`);
      limit = n;
    } else if (arg === "--from") {
      const val = args[++i];
      if (!val) throw new Error("--from requires a date (e.g. 2026-02-01)");
      const ms = parseDateMs(val, "start");
      if (ms === null) throw new Error(`Invalid --from date "${val}". Use ISO format: 2026-02-01`);
      fromMs = ms;
    } else if (arg === "--to") {
      const val = args[++i];
      if (!val) throw new Error("--to requires a date (e.g. 2026-02-20)");
      const ms = parseDateMs(val, "end");
      if (ms === null) throw new Error(`Invalid --to date "${val}". Use ISO format: 2026-02-20`);
      toMs = ms;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown flag "${arg}"`);
    } else {
      queryWords.push(arg);
    }
  }

  const queryText = queryWords.join(" ").trim();
  if (!queryText) {
    throw new Error('Query text is required. Usage: code-session-memory query "your question here"');
  }

  return { queryText, source, limit, fromMs, toMs };
}

/**
 * Parses a date string (ISO 8601 date or datetime) into milliseconds.
 * For "start" boundary: beginning of the day (00:00:00 UTC).
 * For "end" boundary: end of the day (23:59:59.999 UTC).
 * Returns null if the string is not a valid date.
 */
export function parseDateMs(value: string, boundary: "start" | "end"): number | null {
  // Date-only format: YYYY-MM-DD — interpret as UTC day boundaries
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const ms = Date.parse(value);
  if (isNaN(ms)) return null;

  if (dateOnly && boundary === "end") {
    // End of that UTC day
    return ms + 24 * 60 * 60 * 1000 - 1;
  }
  return ms;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatResult(result: QueryResult, index: number): string {
  const lines: string[] = [];

  const distStr = typeof result.distance === "number"
    ? dim(`[${result.distance.toFixed(4)}]`)
    : "";
  const sourceStr = result.source ? dim(`(${result.source})`) : "";
  const titleStr = result.session_title
    ? bold(`"${result.session_title}"`)
    : dim("(untitled)");

  lines.push(`${yellow(String(index) + ".")} ${distStr} ${titleStr} ${sourceStr}`);

  if (result.section) {
    lines.push(`   ${dim("Section:")} ${result.section}`);
  }

  if (result.url) {
    const chunkInfo =
      typeof result.chunk_index === "number" && typeof result.total_chunks === "number"
        ? `Chunk ${result.chunk_index + 1}/${result.total_chunks} — `
        : "";
    lines.push(`   ${dim(chunkInfo)}${cyan(result.url)}`);
  }

  lines.push(`   ${dim("─".repeat(60))}`);

  // Indent and trim the content
  const content = (result.content ?? "").trim();
  const MAX_CONTENT_CHARS = 400;
  const truncated =
    content.length > MAX_CONTENT_CHARS
      ? content.slice(0, MAX_CONTENT_CHARS) + dim("…")
      : content;
  const indented = truncated
    .split("\n")
    .map((l) => `   ${l}`)
    .join("\n");
  lines.push(indented);
  lines.push(`   ${dim("─".repeat(60))}`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export async function cmdQuery(args: string[]): Promise<void> {
  // 1. Parse args
  let opts: QueryOptions;
  try {
    opts = parseQueryArgs(args);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
    return; // guard for test environments where process.exit is mocked
  }

  // 2. Check OPENAI_API_KEY
  if (!process.env.OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY environment variable is not set.");
    process.exit(1);
    return; // guard for test environments where process.exit is mocked
  }

  // 3. Open DB
  const dbPath = resolveDbPath();
  const db = openDatabase({ dbPath });

  try {
    // 4. Embed the query
    const embedder = createEmbedder();
    const embedding = await embedder.embedText(opts.queryText);

    // 5. Search
    const results = queryByEmbedding(
      db,
      embedding,
      opts.limit,
      undefined, // no project filter
      opts.source,
      opts.fromMs,
      opts.toMs,
    );

    // 6. Print results
    if (results.length === 0) {
      console.log(
        `No results found for ${bold(`"${opts.queryText}"`)}` +
        (opts.source ? ` in source "${opts.source}"` : "") +
        ".",
      );
      return;
    }

    const filterDesc = [
      opts.source ? `source=${opts.source}` : null,
      opts.fromMs ? `from=${new Date(opts.fromMs).toISOString().slice(0, 10)}` : null,
      opts.toMs   ? `to=${new Date(opts.toMs + 1).toISOString().slice(0, 10)}` : null,
      `limit=${opts.limit}`,
    ].filter(Boolean).join(", ");

    console.log(
      `\n${bold(`Found ${results.length} result(s)`)} for ${bold(`"${opts.queryText}"`)}` +
      (filterDesc ? dim(` (${filterDesc})`) : "") +
      "\n",
    );

    for (let i = 0; i < results.length; i++) {
      console.log(formatResult(results[i], i + 1));
      console.log();
    }
  } finally {
    db.close();
  }
}
