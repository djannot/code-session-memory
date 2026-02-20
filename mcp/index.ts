#!/usr/bin/env node
/**
 * opencode-memory MCP server (stdio transport).
 *
 * Exposes two tools:
 *   - query_sessions   — semantic search across indexed OpenCode sessions
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
const openAiApiKey = process.env.OPENAI_API_KEY;
const openAiModel = process.env.OPENAI_MODEL ?? "text-embedding-3-large";

if (!openAiApiKey) {
  console.error("Error: OPENAI_API_KEY environment variable is required.");
  process.exit(1);
}

if (!fs.existsSync(dbPath)) {
  console.error(
    `Error: Database not found at ${dbPath}.\nRun "npx opencode-memory install" first.`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Embedding function
// ---------------------------------------------------------------------------

const openai = new OpenAI({ apiKey: openAiApiKey });

async function createEmbedding(text: string): Promise<number[]> {
  const MAX_CHARS = 8191 * 4;
  const input = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
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
  name: "opencode-memory",
  version: "0.1.0",
});

// Zod schemas defined separately to avoid type instantiation depth issues
const querySessionsSchema = {
  queryText: z.string().min(1).describe("Natural language description of what you are looking for."),
  project: z.string().optional().describe("Filter results to a specific project directory path (e.g. '/Users/me/myproject'). Optional."),
  limit: z.number().int().min(1).optional().describe("Maximum number of results to return. Defaults to 5."),
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
  "Semantically search across all indexed OpenCode sessions stored in the vector database. Returns the most relevant chunks from past sessions.",
  querySessionsSchema,
  async (args: { queryText: string; project?: string; limit?: number }) =>
    querySessionsHandler({ ...args, limit: args.limit ?? 5 }),
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
  console.error(`opencode-memory MCP server running (DB: ${dbPath})`);
}

main().catch((err) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
