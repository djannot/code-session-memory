#!/usr/bin/env node
/**
 * code-session-memory MCP server (stdio transport).
 *
 * Exposes two tools:
 *   - query_sessions     — semantic search across indexed sessions
 *   - get_session_chunks — retrieve ordered chunks for a specific session URL
 *
 * Environment variables:
 *   OPENAI_API_KEY           — required for embedding generation
 *   OPENAI_MODEL             — embedding model (default: text-embedding-3-large)
 *   OPENCODE_MEMORY_DB_PATH  — path to the sqlite-vec DB
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OpenAI } from "openai";
import * as sqliteVec from "sqlite-vec";
import Database from "better-sqlite3";
import fs from "fs";
import { resolveDbPath } from "../src/database";
import { createSqliteProvider, createToolHandlers } from "./server";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const dbPath = resolveDbPath();
const openAiModel = process.env.OPENAI_MODEL ?? "text-embedding-3-large";

// ---------------------------------------------------------------------------
// Embedding function
// ---------------------------------------------------------------------------

let openaiClient: OpenAI | null = null;

function getOpenAiClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY environment variable is required for query_sessions.",
    );
  }
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

async function createEmbedding(text: string): Promise<number[]> {
  const MAX_CHARS = 8191 * 4;
  const input = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  const openai = getOpenAiClient();
  const response = await openai.embeddings.create({ model: openAiModel, input });
  const embedding = response.data?.[0]?.embedding;
  if (!embedding) throw new Error("No embedding returned from OpenAI API");
  return embedding;
}

// ---------------------------------------------------------------------------
// SQLite provider + tool handlers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const provider = createSqliteProvider({
  dbPath,
  sqliteVec: sqliteVec as unknown as { load: (db: unknown) => void },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Database: Database as unknown as any,
  fs,
});

const { querySessionsHandler, getSessionChunksHandler } = createToolHandlers({
  createEmbedding,
  querySessions: provider.querySessions,
  getSessionChunks: provider.getSessionChunks,
});

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "code-session-memory",
  version: "0.3.0",
});

// Zod schemas defined separately to avoid type instantiation depth issues
const querySessionsSchema = {
  queryText: z.string().min(1).describe("Natural language description of what you are looking for."),
  project: z.string().optional().describe("Filter results to a specific project directory path (e.g. '/Users/me/myproject'). Optional."),
  source: z.enum(["opencode", "claude-code", "cursor", "vscode", "codex"]).optional().describe("Filter results by tool source: 'opencode', 'claude-code', 'cursor', 'vscode', or 'codex'. Optional — omit to search across all."),
  limit: z.number().int().min(1).optional().describe("Maximum number of results to return. Defaults to 5."),
  fromDate: z.string().optional().describe("Return only chunks indexed on or after this date. ISO 8601 format, e.g. '2026-02-01' or '2026-02-20T15:00:00Z'. Optional."),
  toDate: z.string().optional().describe("Return only chunks indexed on or before this date. ISO 8601 format, e.g. '2026-02-20'. A date-only value is treated as end-of-day UTC. Optional."),
};

const getSessionChunksSchema = {
  sessionUrl: z.string().min(1).describe("The session message URL from a query_sessions result (e.g. 'session://ses_xxx#msg_yyy')."),
  startIndex: z.number().int().min(0).optional().describe("First chunk index to retrieve (0-based, inclusive). Optional."),
  endIndex: z.number().int().min(0).optional().describe("Last chunk index to retrieve (0-based, inclusive). Optional."),
};

// Cast server to any to avoid deep MCP SDK Zod type instantiation (TS2589)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const serverAny = server as any;

serverAny.tool(
  "query_sessions",
  "Semantically search across all indexed sessions stored in the vector database. Returns the most relevant chunks from past sessions. Sessions from OpenCode, Claude Code, Cursor, VS Code, and Codex are indexed into the same shared database.",
  querySessionsSchema,
  async (args: { queryText: string; project?: string; source?: string; limit?: number; fromDate?: string; toDate?: string }) => {
    // Parse ISO 8601 date strings into unix milliseconds.
    // For toDate, a date-only string (no time component) is treated as end-of-day UTC
    // by adding 86399999ms (23:59:59.999).
    let fromMs: number | undefined;
    let toMs: number | undefined;
    if (args.fromDate) {
      const t = new Date(args.fromDate).getTime();
      if (!Number.isNaN(t)) fromMs = t;
    }
    if (args.toDate) {
      const t = new Date(args.toDate).getTime();
      if (!Number.isNaN(t)) {
        // If the value is a date-only string (no 'T' separator), bump to end-of-day
        toMs = args.toDate.includes("T") ? t : t + 86399999;
      }
    }
    return querySessionsHandler({ ...args, limit: args.limit ?? 5, fromMs, toMs });
  },
);

serverAny.tool(
  "get_session_chunks",
  "Retrieve the ordered content chunks for a specific session message. Use the URL from query_sessions results (e.g. 'session://ses_xxx#msg_yyy') to get the full context around a match.",
  getSessionChunksSchema,
  async (args: { sessionUrl: string; startIndex?: number; endIndex?: number }) =>
    getSessionChunksHandler(args),
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`code-session-memory MCP server running (DB: ${dbPath})`);
}

main().catch((err) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
