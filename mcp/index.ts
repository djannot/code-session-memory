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
 *   OPENCODE_MEMORY_DB_PATH  — path to the sqlite-vec DB (SQLite backend)
 *   CSM_BACKEND              — "sqlite" (default) or "postgres"
 *   CSM_POSTGRES_URL         — PostgreSQL connection string (when backend=postgres)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { OpenAI } from "openai";
import { resolveBackendConfig } from "../src/config";
import { createProvider } from "../src/providers";
import type { DatabaseProvider } from "../src/providers";
import { createToolHandlers } from "./server";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

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
// Provider-based query functions
// ---------------------------------------------------------------------------

function createProviderQueryFunctions(provider: DatabaseProvider) {
  return {
    async querySessions(
      embedding: number[],
      topK: number,
      project?: string,
      source?: string,
      fromMs?: number,
      toMs?: number,
      includeSections?: string[],
      excludeSections?: string[],
    ) {
      return provider.queryByEmbedding(embedding, topK, {
        projectFilter: project,
        sourceFilter: source as Parameters<DatabaseProvider["queryByEmbedding"]>[2]["sourceFilter"],
        fromMs,
        toMs,
        sectionOpts: { includeSections, excludeSections },
      });
    },

    async querySessionsHybrid(
      embedding: number[],
      queryText: string,
      topK: number,
      project?: string,
      source?: string,
      fromMs?: number,
      toMs?: number,
      includeSections?: string[],
      excludeSections?: string[],
    ) {
      return provider.queryHybrid(embedding, queryText, topK, {
        projectFilter: project,
        sourceFilter: source as Parameters<DatabaseProvider["queryHybrid"]>[3]["sourceFilter"],
        fromMs,
        toMs,
        sectionOpts: { includeSections, excludeSections },
      });
    },

    async getSessionChunks(url: string, startIndex?: number, endIndex?: number) {
      return provider.getChunksByUrl(url, startIndex, endIndex);
    },
  };
}

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
  source: z.enum(["opencode", "claude-code", "cursor", "vscode", "codex", "gemini-cli"]).optional().describe("Filter results by tool source: 'opencode', 'claude-code', 'cursor', 'vscode', 'codex', or 'gemini-cli'. Optional — omit to search across all."),
  limit: z.number().int().min(1).optional().describe("Maximum number of results to return. Defaults to 5."),
  fromDate: z.string().optional().describe("Return only chunks indexed on or after this date. ISO 8601 format, e.g. '2026-02-01' or '2026-02-20T15:00:00Z'. Optional."),
  toDate: z.string().optional().describe("Return only chunks indexed on or before this date. ISO 8601 format, e.g. '2026-02-20'. A date-only value is treated as end-of-day UTC. Optional."),
  hybrid: z.boolean().optional().describe("Enable hybrid search (semantic + keyword with RRF merging). Default false (semantic only). Use when searching for exact terms or code identifiers."),
  includeSections: z.string().optional().describe("Comma-separated section prefixes to include (e.g. 'User,Assistant'). Only chunks whose section matches one of these prefixes are returned. Optional."),
  excludeSections: z.string().optional().describe("Comma-separated section prefixes to exclude (e.g. 'Tool,Tool Result'). Chunks matching any of these prefixes are skipped. Optional."),
};

const getSessionChunksSchema = {
  sessionUrl: z.string().min(1).describe("The session message URL from a query_sessions result (e.g. 'session://ses_xxx#msg_yyy')."),
  startIndex: z.number().int().min(0).optional().describe("First chunk index to retrieve (0-based, inclusive). Optional."),
  endIndex: z.number().int().min(0).optional().describe("Last chunk index to retrieve (0-based, inclusive). Optional."),
};

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  // Create the backend provider (SQLite or Postgres based on config)
  const config = resolveBackendConfig();
  const provider = await createProvider(config);
  const backendLabel = config.backend === "postgres"
    ? `postgres: ${(config as { connectionString: string }).connectionString.replace(/:[^:@]*@/, ":***@")}`
    : `sqlite: ${(config as { dbPath: string }).dbPath}`;

  const queryFns = createProviderQueryFunctions(provider);
  const { querySessionsHandler, getSessionChunksHandler } = createToolHandlers({
    createEmbedding,
    ...queryFns,
  });

  // Cast server to any to avoid deep MCP SDK Zod type instantiation (TS2589)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const serverAny = server as any;

  serverAny.tool(
    "query_sessions",
    "Semantically search across all indexed sessions stored in the vector database. Returns the most relevant chunks from past sessions. Sessions from OpenCode, Claude Code, Cursor, VS Code, Codex, and Gemini CLI are indexed into the same shared database.",
    querySessionsSchema,
    async (args: { queryText: string; project?: string; source?: string; limit?: number; fromDate?: string; toDate?: string; hybrid?: boolean; includeSections?: string; excludeSections?: string }) => {
      let fromMs: number | undefined;
      let toMs: number | undefined;
      if (args.fromDate) {
        const t = new Date(args.fromDate).getTime();
        if (!Number.isNaN(t)) fromMs = t;
      }
      if (args.toDate) {
        const t = new Date(args.toDate).getTime();
        if (!Number.isNaN(t)) {
          toMs = args.toDate.includes("T") ? t : t + 86399999;
        }
      }
      return querySessionsHandler({ ...args, limit: args.limit ?? 5, fromMs, toMs, includeSections: args.includeSections, excludeSections: args.excludeSections });
    },
  );

  serverAny.tool(
    "get_session_chunks",
    "Retrieve the ordered content chunks for a specific session message. Use the URL from query_sessions results (e.g. 'session://ses_xxx#msg_yyy') to get the full context around a match.",
    getSessionChunksSchema,
    async (args: { sessionUrl: string; startIndex?: number; endIndex?: number }) =>
      getSessionChunksHandler(args),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`code-session-memory MCP server running (${backendLabel})`);
}

main().catch((err) => {
  console.error("Failed to start MCP server:", err);
  process.exit(1);
});
