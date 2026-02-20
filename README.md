# code-session-memory

Automatic vector memory for [OpenCode](https://opencode.ai), [Claude Code](https://claude.ai/code), and [Cursor](https://www.cursor.com) sessions — shared across all three tools.

Every time the AI agent finishes its turn, `code-session-memory` automatically indexes the new messages into a local [sqlite-vec](https://github.com/asg017/sqlite-vec) vector database. Past sessions become semantically searchable — both by the AI agent (via the MCP server) and by you. Sessions from OpenCode, Claude Code, and Cursor are stored in the **same database**, so memory is shared across tools.

## How it works

```
OpenCode (session.idle)    Claude Code (Stop hook)    Cursor (stop hook)
        │                           │                        │
        │  REST API messages        │  JSONL transcript      │  JSONL transcript
        ▼                           ▼                        ▼
session-to-md          transcript-to-messages   cursor-transcript-to-messages
        │                           │                        │
        └───────────────────────────┬────────────────────────┘
                                    ▼
                         chunker  →  heading-aware chunks (≤1000 tokens, 10% overlap)
                                    │
                                    ▼
                         embedder  →  OpenAI text-embedding-3-large (3072 dims)
                                    │    (all chunks batched in a single API call per turn)
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
- OpenCode, Claude Code, and/or Cursor installed

### Install

```bash
npx code-session-memory install
```

The `install` command sets up everything for all three tools in one shot:

**OpenCode:**
1. Copies the plugin to `~/.config/opencode/plugins/code-session-memory.ts`
2. Copies the skill to `~/.config/opencode/skills/code-session-memory.md`
3. Writes the MCP server entry into `~/.config/opencode/opencode.json`

**Claude Code:**
1. Writes a `Stop` hook to `~/.claude/settings.json` (fires after each agent turn)
2. Injects the skill into `~/.claude/CLAUDE.md` (with idempotent markers)
3. Writes the MCP server entry into `~/.claude.json`

**Cursor:**
1. Writes a `stop` hook to `~/.cursor/hooks.json` (fires after each agent turn; requires Cursor v2.5+)
2. Writes the MCP server entry into `~/.cursor/mcp.json`
3. Copies the skill to `~/.cursor/skills/code-session-memory/SKILL.md`

**All tools share:**
- The same database at `~/.local/share/code-session-memory/sessions.db`
- The same MCP server for querying past sessions

Then **restart OpenCode / Claude Code / Cursor** to activate.

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
    Stop hook      ~/.claude.json                                      ✓
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
| `source` | string | no | Filter by tool: `"opencode"`, `"claude-code"`, or `"cursor"` |
| `limit` | number | no | Max results (default: 5) |
| `fromDate` | string | no | Return chunks indexed on or after this date (ISO 8601, e.g. `"2026-02-01"`) |
| `toDate` | string | no | Return chunks indexed on or before this date (ISO 8601, e.g. `"2026-02-20"`) |

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

### Browsing sessions

You can browse, inspect, and delete indexed sessions directly from the CLI:

```bash
npx code-session-memory sessions           # interactive browser (source → date → session)
```

The interactive browser lists all sessions with their title, date, source tool, and chunk count. Select a session to:
- **Print** — dump all chunks to stdout (useful for piping or inspection)
- **Delete** — remove the session from the DB (with confirmation)
- **Back** — return to the session list

You can also `print` or `delete` directly. Without an ID, an interactive picker opens:

```bash
npx code-session-memory sessions print             # pick interactively, then print
npx code-session-memory sessions print <id>        # print directly by session ID

npx code-session-memory sessions delete            # pick interactively, then delete
npx code-session-memory sessions delete <id>       # delete directly by session ID
```

**Print output example:**
```
────────────────────────────────────────────────────────────────────────
Session: Add authentication middleware
Source:  opencode  2026-02-18
Project: /Users/you/myproject
ID:      ses_abc123
Chunks:  12
────────────────────────────────────────────────────────────────────────

## Chunk 1/12  —  Section: User

How can I add JWT authentication to the Express middleware?

## Chunk 2/12  —  Section: Assistant

...
```

> **Note:** Deleting a session only removes it from the database. If the original session files still exist on disk, the session will be re-indexed automatically on the next agent turn.

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
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Override the Claude Code config directory. |
| `CURSOR_CONFIG_DIR` | `~/.cursor` | Override the Cursor config directory. |
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
│   ├── transcript-to-messages.ts          # Claude Code JSONL transcript parser
│   ├── cursor-to-messages.ts             # Cursor state.vscdb reader (metadata + title)
│   ├── cursor-transcript-to-messages.ts  # Cursor JSONL transcript parser → FullMessage[]
│   ├── indexer.ts                        # Orchestrator: incremental indexing
│   ├── indexer-cli.ts                    # Node.js subprocess (called by OpenCode plugin)
│   ├── indexer-cli-claude.ts             # Node.js subprocess (called by Claude Code hook)
│   ├── indexer-cli-cursor.ts             # Node.js subprocess (called by Cursor stop hook)
│   ├── cli.ts                            # install / status / uninstall / reset-db commands
│   └── cli-sessions.ts                   # sessions list / print / delete / purge (TUI)
├── mcp/
│   ├── server.ts                 # MCP query handlers (testable, injected deps)
│   └── index.ts                  # MCP stdio server entry point
├── plugin/
│   └── memory.ts                 # OpenCode plugin (session.idle hook)
├── skill/
│   └── memory.md                 # Skill instructions (injected into all tools)
├── scripts/
│   └── generate-fixtures.ts      # Generates committed e2e test fixtures (run manually)
└── tests/
    ├── chunker.test.ts
    ├── database.test.ts
    ├── embedder.test.ts
    ├── indexer.test.ts
    ├── mcp-server.test.ts
    ├── session-to-md.test.ts
    ├── cursor-to-messages.test.ts           # Unit tests: Cursor SQLite reader
    ├── cursor-transcript-to-messages.test.ts # Unit tests: Cursor JSONL parser
    ├── e2e-claude.test.ts                   # End-to-end: Claude Code pipeline
    ├── e2e-opencode.test.ts                 # End-to-end: OpenCode pipeline
    ├── e2e-cursor.test.ts                   # End-to-end: Cursor pipeline
    └── fixtures/                  # Committed session files (generated by generate-fixtures)
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

# Regenerate e2e fixtures (requires claude and opencode CLIs)
npm run generate-fixtures
```

### Running tests

Tests use [Vitest](https://vitest.dev) and run without any external dependencies:
- No real OpenAI API calls — the embedder is mocked
- No real DB files — SQLite uses in-memory databases (`:memory:`) for unit tests, temp files for indexer/e2e tests
- E2e tests use committed fixture files in `tests/fixtures/` (real transcripts, no CLI calls during `npm test`)

```
 ✓ tests/chunker.test.ts                          (15 tests)
 ✓ tests/mcp-server.test.ts                       (14 tests)
 ✓ tests/session-to-md.test.ts                    (21 tests)
 ✓ tests/embedder.test.ts                          (9 tests)
 ✓ tests/database.test.ts                         (27 tests)
 ✓ tests/indexer.test.ts                           (9 tests)
 ✓ tests/cursor-to-messages.test.ts               (15 tests)
 ✓ tests/cursor-transcript-to-messages.test.ts     (7 tests)
 ✓ tests/e2e-claude.test.ts                       (18 tests)
 ✓ tests/e2e-cursor.test.ts                        (8 tests)
 ✓ tests/e2e-opencode.test.ts                     (14 tests)
   Tests  157 passed
```

To refresh the e2e fixtures (e.g. after changing the indexer or parsers), run:
```bash
npm run generate-fixtures
```
This invokes the real `claude` and `opencode` CLIs to generate two-turn sessions with tool use, reads the most recent Cursor session from the live `state.vscdb`, then commits all results to `tests/fixtures/`.

## Uninstall

```bash
npx code-session-memory uninstall
```

This removes the plugin, hooks, skill files, and MCP config entries for all tools (OpenCode, Claude Code, and Cursor). The database is **not** removed automatically.

To delete individual sessions instead of wiping everything, use the [session browser](#browsing-sessions):
```bash
npx code-session-memory sessions
npx code-session-memory sessions delete <id>
```

To wipe the entire database:
```bash
rm ~/.local/share/code-session-memory/sessions.db
```

Or use the built-in command, which prompts for confirmation before deleting:

```bash
npx code-session-memory reset-db
```

```
code-session-memory reset-db

  Database: ~/.local/share/code-session-memory/sessions.db
  Indexed chunks:   1842
  Sessions tracked: 47

  This will permanently delete all indexed data. Confirm? [y/N] y

  Done. Database reset — all indexed data removed.
```

## Architecture notes

### Incremental indexing

The plugin/hook fires on every agent turn. To avoid re-processing the entire session history each time, the indexer:

1. Reads `last_indexed_message_id` from the `sessions_meta` table
2. Skips all messages up to and including that ID
3. Processes only the new messages — renders, chunks, and embeds all of them in a **single batched OpenAI API call**
4. Updates `last_indexed_message_id` after success

This makes each indexing pass O(new messages) rather than O(all messages), and limits network round-trips to one embedding call per turn regardless of message count.

### Why a Node.js subprocess?

OpenCode plugins run inside **Bun**, but `better-sqlite3` and `sqlite-vec` are native Node.js addons that don't load under Bun. The plugin therefore spawns a Node.js subprocess (`indexer-cli.js`) to handle all database operations. The Claude Code hook calls a similar subprocess (`indexer-cli-claude.js`) which reads the transcript JSONL from disk.

### Claude Code transcript parsing

Claude Code writes a JSONL transcript after each session turn. The parser (`transcript-to-messages.ts`) handles:
- Deduplicating streaming `assistant` chunks (keeps the last entry per `message.id`)
- Skipping internal `thinking` blocks, metadata entries, and error messages
- Converting `tool_use` / `tool_result` entries to readable markdown

### Cursor session reading

Cursor provides a `transcript_path` field in the stop hook payload — a JSONL file written **synchronously before the hook fires**, so it is always complete and race-condition-free. Each line is `{ "role": "user"|"assistant", "message": { "content": [{ "type": "text", "text": "..." }] } }`. The reader (`cursor-transcript-to-messages.ts`) parses this file directly, strips Cursor's `<user_query>` wrapper tags, and assigns stable `composerId-lineIndex` IDs for incremental indexing.

Session metadata (title only) is read best-effort from the SQLite `state.vscdb`. The Cursor `stop` hook fires after each agent turn and requires **Cursor v2.5+**.

### Chunking strategy

- Heading-aware splitting — headings define semantic boundaries
- Max 1000 whitespace-tokenized words per chunk
- Sections below 150 words are merged with adjacent sections
- Sections above 1000 words are split with 10% overlap
- Each chunk gets a `[Session: Title > Section]` breadcrumb prefix injected before embedding, improving retrieval precision

### MCP server

The MCP server uses **stdio transport** — the simplest and most reliable transport for local use. It opens and closes the SQLite connection on each query (no persistent connection), making it safe to run alongside the indexer. The `query_sessions` tool supports filtering by `source`, `project`, and date range (`fromDate`/`toDate`).

## License

MIT
