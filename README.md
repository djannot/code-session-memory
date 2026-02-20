# code-session-memory

Automatic vector memory for [OpenCode](https://opencode.ai) and [Claude Code](https://claude.ai/code) sessions — shared across both tools.

Every time the AI agent finishes its turn, `code-session-memory` automatically indexes the new messages into a local [sqlite-vec](https://github.com/asg017/sqlite-vec) vector database. Past sessions become semantically searchable — both by the AI agent (via the MCP server) and by you. Sessions from both OpenCode and Claude Code are stored in the **same database**, so memory is shared across tools.

## How it works

```
OpenCode (session.idle event)          Claude Code (Stop hook)
        │                                       │
        │  fetches messages via REST API        │  reads JSONL transcript
        ▼                                       ▼
session-to-md                        transcript-to-messages
        │                                       │
        └───────────────┬───────────────────────┘
                        ▼
             chunker  →  heading-aware chunks (≤1000 tokens, 10% overlap)
                        │
                        ▼
             embedder  →  OpenAI text-embedding-3-large (3072 dims)
                        │
                        ▼
             sqlite-vec DB  →  ~/.local/share/code-session-memory/sessions.db
                        │
                        ▼
             MCP server  →  query_sessions / get_session_chunks tools
```

Only **new messages** are indexed on each turn — previously indexed messages are skipped (tracked via `sessions_meta` table). This makes each indexing pass fast, even in long sessions.

## Installation

### Prerequisites

- Node.js ≥ 18
- An OpenAI API key (for `text-embedding-3-large`)
- OpenCode and/or Claude Code installed

### Install

```bash
npx code-session-memory install
```

The `install` command sets up everything for both tools in one shot:

**OpenCode:**
1. Copies the plugin to `~/.config/opencode/plugins/code-session-memory.ts`
2. Copies the skill to `~/.config/opencode/skills/code-session-memory.md`
3. Writes the MCP server entry into `~/.config/opencode/opencode.json`

**Claude Code:**
1. Writes a `Stop` hook to `~/.claude/settings.json` (fires after each agent turn)
2. Injects the skill into `~/.claude/CLAUDE.md` (with idempotent markers)
3. Registers the MCP server via `claude mcp add`

**Both tools share:**
- The same database at `~/.local/share/code-session-memory/sessions.db`
- The same MCP server for querying past sessions

Then **restart OpenCode / Claude Code** to activate.

### Set your API key

```bash
export OPENAI_API_KEY=sk-...
```

Add this to your shell profile (`.bashrc`, `.zshrc`, etc.) so it's always available.

## Usage

Once installed, memory indexing is **fully automatic**. No further action needed — sessions are indexed as you use OpenCode or Claude Code.

### Verify installation

```bash
npx code-session-memory status
```

Output:
```
code-session-memory status

  Database       ~/.local/share/code-session-memory/sessions.db  ✓
  Indexed chunks:   1842
  Sessions tracked: 47

  OpenCode
    Plugin         ~/.config/opencode/plugins/code-session-memory.ts  ✓
    Skill          ~/.config/opencode/skills/code-session-memory.md    ✓
    MCP server     /path/to/dist/mcp/index.js                          ✓
    MCP config     ~/.config/opencode/opencode.json                    ✓

  Claude Code
    Stop hook      ~/.claude/settings.json                             ✓
    Skill          ~/.claude/CLAUDE.md                                 ✓
    MCP server     /path/to/dist/mcp/index.js                          ✓
```

### MCP tools

The agent can use two MCP tools (and will automatically via the installed skill):

#### `query_sessions`

Semantic search across all indexed sessions.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `queryText` | string | yes | Natural language query |
| `project` | string | no | Filter by project directory path |
| `source` | string | no | Filter by tool: `"opencode"` or `"claude-code"` |
| `limit` | number | no | Max results (default: 5) |

Example result:
```
Result 1:
  Content: [Session: Add dark mode toggle > User]

  How can I implement a dark mode toggle using CSS variables?
  Distance: 0.1823
  URL: session://ses_abc123#msg_def456
  Section: User
  Chunk: 1 of 1
---
```

#### `get_session_chunks`

Retrieve the full ordered content of a specific session message. Use the `session://ses_xxx#msg_yyy` URL from `query_sessions` results.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `sessionUrl` | string | yes | URL from `query_sessions` result |
| `startIndex` | number | no | First chunk index (0-based) |
| `endIndex` | number | no | Last chunk index (0-based, inclusive) |

### Asking the agent about past sessions

The installed skill teaches the agent when and how to use these tools. Example prompts:

```
How did we implement the authentication middleware last week?
Have we discussed this error before?
What was our decision about the database schema?
Show me how we solved the TypeScript config issue.
```

## Configuration

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | — | **Required.** Used for embedding generation. |
| `OPENCODE_MEMORY_DB_PATH` | `~/.local/share/code-session-memory/sessions.db` | Override the database path. |
| `OPENCODE_CONFIG_DIR` | `~/.config/opencode` | Override the OpenCode config directory. |
| `OPENAI_MODEL` | `text-embedding-3-large` | Override the embedding model. |

### Database path

The default database path works on both **macOS** and **Linux**. On macOS, `~/.local/share` is used for cross-platform consistency (rather than `~/Library/Application Support`).

To change it:
```bash
export OPENCODE_MEMORY_DB_PATH=/custom/path/sessions.db
npx code-session-memory install
```

## Project structure

```
code-session-memory/
├── src/
│   ├── types.ts                  # Shared TypeScript types
│   ├── database.ts               # SQLite-vec: init, insert, query
│   ├── chunker.ts                # Heading-aware markdown chunker
│   ├── embedder.ts               # OpenAI embeddings (batched)
│   ├── session-to-md.ts          # OpenCode SDK messages → markdown
│   ├── transcript-to-messages.ts # Claude Code JSONL transcript parser
│   ├── indexer.ts                # Orchestrator: incremental indexing
│   ├── indexer-cli.ts            # Node.js subprocess (called by OpenCode plugin)
│   ├── indexer-cli-claude.ts     # Node.js subprocess (called by Claude Code hook)
│   └── cli.ts                    # install / status / uninstall commands
├── mcp/
│   ├── server.ts                 # MCP query handlers (testable, injected deps)
│   └── index.ts                  # MCP stdio server entry point
├── plugin/
│   └── memory.ts                 # OpenCode plugin (session.idle hook)
├── skill/
│   └── memory.md                 # Skill instructions (injected into both tools)
└── tests/
    ├── chunker.test.ts
    ├── database.test.ts
    ├── embedder.test.ts
    ├── indexer.test.ts
    ├── mcp-server.test.ts
    └── session-to-md.test.ts
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage
```

### Running tests

Tests use [Vitest](https://vitest.dev) and run without any external dependencies:
- No real OpenAI API calls — the embedder is mocked
- No real DB files — SQLite uses in-memory databases (`:memory:`) for unit tests
- Indexer tests use a temp directory on disk

```
 ✓ tests/chunker.test.ts       (15 tests)
 ✓ tests/mcp-server.test.ts    (13 tests)
 ✓ tests/session-to-md.test.ts (18 tests)
 ✓ tests/embedder.test.ts       (9 tests)
 ✓ tests/database.test.ts      (25 tests)
 ✓ tests/indexer.test.ts        (8 tests)
   Tests  88 passed
```

## Uninstall

```bash
npx code-session-memory uninstall
```

This removes the plugin, hooks, and skill files for both tools. The database is **not** removed automatically.

To also remove the database:
```bash
rm ~/.local/share/code-session-memory/sessions.db
```

## Architecture notes

### Incremental indexing

The plugin/hook fires on every agent turn. To avoid re-processing the entire session history each time, the indexer:

1. Reads `last_indexed_message_id` from the `sessions_meta` table
2. Skips all messages up to and including that ID
3. Processes only the new messages
4. Updates `last_indexed_message_id` after success

This makes each indexing pass O(new messages) rather than O(all messages).

### Why a Node.js subprocess?

OpenCode plugins run inside **Bun**, but `better-sqlite3` and `sqlite-vec` are native Node.js addons that don't load under Bun. The plugin therefore spawns a Node.js subprocess (`indexer-cli.js`) to handle all database operations. The Claude Code hook calls a similar subprocess (`indexer-cli-claude.js`) which reads the transcript JSONL from disk.

### Claude Code transcript parsing

Claude Code writes a JSONL transcript after each session turn. The parser (`transcript-to-messages.ts`) handles:
- Deduplicating streaming `assistant` chunks (keeps the last entry per `message.id`)
- Skipping internal `thinking` blocks, metadata entries, and error messages
- Converting `tool_use` / `tool_result` entries to readable markdown

### Chunking strategy

- Heading-aware splitting — headings define semantic boundaries
- Max 1000 whitespace-tokenized words per chunk
- Sections below 150 words are merged with adjacent sections
- Sections above 1000 words are split with 10% overlap
- Each chunk gets a `[Session: Title > Section]` breadcrumb prefix injected before embedding, improving retrieval precision

### MCP server

The MCP server uses **stdio transport** — the simplest and most reliable transport for local use. It opens and closes the SQLite connection on each query (no persistent connection), making it safe to run alongside the indexer. The `query_sessions` tool accepts an optional `source` parameter to filter results to a specific tool.

## License

MIT
