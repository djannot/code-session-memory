# code-session-memory

Automatic vector memory for [OpenCode](https://opencode.ai), [Claude Code](https://claude.ai/code), [Cursor](https://www.cursor.com), [VS Code](https://code.visualstudio.com), Codex, and Gemini CLI sessions — shared across all tools.

Every time the AI agent finishes its turn, `code-session-memory` automatically indexes the new messages into a local [sqlite-vec](https://github.com/asg017/sqlite-vec) vector database. Past sessions become semantically searchable — both by the AI agent (via the MCP server) and by you. Sessions from OpenCode, Claude Code, Cursor, VS Code, Codex, and Gemini CLI are stored in the **same database**, so memory is shared across tools.

## How it works

```
OpenCode (session.idle)   Claude Code (Stop hook)   Cursor (stop hook)   VS Code (Stop hook)   Codex (notify hook)   Gemini CLI (AfterAgent)
        │                          │                       │                     │                      │                      │
        │ REST API messages        │ JSONL transcript      │ JSONL transcript    │ JSONL transcript     │ JSONL session        │ JSON session
        ▼                          ▼                       ▼                     ▼                      ▼                      ▼
session-to-md           transcript-to-messages   cursor-transcript-to-messages  vscode-transcript-to-messages  codex-session-to-messages  gemini-session-to-messages
        │                          │                       │                     │                      │                      │
        └──────────────────────────┴───────────────────────┴─────────────────────┴──────────────────────┴──────────────────────┘
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
- At least one supported tool installed (OpenCode, Claude Code, Cursor, VS Code, Codex, or Gemini CLI)

### Install

```bash
npx code-session-memory install
```

The `install` command sets up everything for all detected tools on your machine:

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

**VS Code:**
1. Writes a `Stop` hook to `~/.vscode/hooks/code-session-memory.json` (Copilot hook format)
2. Registers the hook file in VS Code's `settings.json` via `chat.hookFilesLocations`
3. Writes the MCP server entry into `~/.config/Code/User/mcp.json` (Linux) or `~/Library/Application Support/Code/User/mcp.json` (macOS)

**Codex:**
1. Writes the MCP server entry into `~/.codex/config.toml`
2. Adds `OPENAI_API_KEY` to Codex MCP environment variable passthrough
3. Writes the `notify` hook in `~/.codex/config.toml` (fires after each agent turn)
4. Copies the skill to `~/.codex/skills/code-session-memory/SKILL.md`

**Gemini CLI:**
1. Writes the MCP server entry into `~/.gemini/settings.json` under `mcpServers.code-session-memory`
2. Writes the `AfterAgent` hook in `~/.gemini/settings.json` (fires after each agent turn)
3. Copies the skill to `~/.gemini/skills/code-session-memory/SKILL.md`

**All tools share:**
- The same database at `~/.local/share/code-session-memory/sessions.db`
- The same MCP server for querying past sessions

Then **restart OpenCode / Claude Code / Cursor / VS Code / Codex / Gemini CLI** to activate.

> **VS Code note:** Ensure **Chat: Use Hooks** is enabled in VS Code settings (it is by default in VS Code 1.109.3+).
>
> **Codex note:** The install command sets `notify = ["node", ".../indexer-cli-codex.js"]` and MCP env passthrough `["OPENAI_API_KEY"]` in `~/.codex/config.toml`.
>
> **Gemini CLI note:** The install command sets an `AfterAgent` hook invoking `indexer-cli-gemini.js` in `~/.gemini/settings.json`.

### Set your API key

```bash
export OPENAI_API_KEY=sk-...
```

Add this to your shell profile (`.bashrc`, `.zshrc`, etc.) so it's always available.

## Usage

Once installed, memory indexing is **fully automatic**. No further action needed — sessions are indexed as you use OpenCode, Claude Code, Cursor, VS Code, Codex, or Gemini CLI.

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

  VS Code
    MCP config     ~/.config/Code/User/mcp.json                        ✓
    Stop hook      ~/.vscode/hooks/code-session-memory.json            ✓
    Hook loc       ~/.config/Code/User/settings.json                   ✓

  Codex
    MCP config     ~/.codex/config.toml                                ✓
    Notify hook    ~/.codex/config.toml                                ✓
    Skill          ~/.codex/skills/code-session-memory/SKILL.md        ✓

  Gemini CLI
    MCP config     ~/.gemini/settings.json                              ✓
    AfterAgent     ~/.gemini/settings.json                              ✓
    Skill          ~/.gemini/skills/code-session-memory/SKILL.md        ✓
```

### MCP tools

The agent can use two MCP tools (and will automatically via the installed skill):

#### `query_sessions`

Semantic search across all indexed sessions.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `queryText` | string | yes | Natural language query |
| `project` | string | no | Filter by project directory path |
| `source` | string | no | Filter by tool: `"opencode"`, `"claude-code"`, `"cursor"`, `"vscode"`, `"codex"`, or `"gemini-cli"` |
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

### Querying from the CLI

You can search your indexed sessions directly from the terminal without going through the AI agent:

```bash
npx code-session-memory query "authentication middleware"
npx code-session-memory query "auth flow" --source opencode
npx code-session-memory query "session summary" --source codex
npx code-session-memory query "hook payload format" --source gemini-cli
npx code-session-memory query "migration" --limit 10
npx code-session-memory query "error handling" --from 2026-02-01 --to 2026-02-20
```

| Flag | Default | Description |
|---|---|---|
| `--source <s>` | none | Filter by tool: `opencode`, `claude-code`, `cursor`, `vscode`, `codex`, or `gemini-cli` |
| `--limit <n>` | 5 | Max number of results |
| `--from <date>` | none | Only include sessions from this date (ISO 8601, e.g. `2026-02-01`) |
| `--to <date>` | none | Only include sessions up to this date (inclusive) |

Requires `OPENAI_API_KEY` to be set (used to embed the query text).

Example output:
```
Found 2 result(s) for "authentication middleware" (limit=5)

1. [1.1665] "Implement auth flow" (opencode)
   Section: Assistant
   Chunk 1/3 — session://ses_abc123#msg_def456
   ────────────────────────────────────────────────────────────
   [Session: Implement auth flow > Assistant]

   We implemented JWT authentication middleware using Express.js...
   ────────────────────────────────────────────────────────────
```

### Browsing sessions

You can browse, inspect, and delete indexed sessions directly from the CLI:

```bash
npx code-session-memory sessions           # interactive browser (source → date → session)
```

The interactive browser lists all sessions with their title, date, source tool, and chunk count. Select a session to:
- **Print** — dump all chunks to stdout (useful for piping or inspection)
- **Compact for restart** — summarize the session with OpenAI and copy the result to your clipboard, ready to paste into a new session of any tool
- **Delete** — remove the session from the DB (with confirmation)
- **Back** — return to the session list

#### Compact for restart

The "Compact for restart" action generates a structured restart document containing:
- **Context** — what was being built or fixed
- **Key Decisions** — architectural and implementation choices
- **Current State** — what is completed and what is in progress
- **Unresolved Issues** — blockers and open questions

For long sessions the compactor uses a map-reduce strategy: it splits the transcript into windows, summarizes each independently, then merges the partial summaries into a final digest.

Requires `OPENAI_API_KEY`. Uses `gpt-5-nano` by default (override with `OPENAI_SUMMARY_MODEL`).
After compaction, the CLI prints total token usage (`input`, `output`, `total`).

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
| `OPENAI_API_KEY` | — | **Required.** Used for embedding generation and session compaction. |
| `OPENCODE_MEMORY_DB_PATH` | `~/.local/share/code-session-memory/sessions.db` | Override the database path. |
| `OPENCODE_CONFIG_DIR` | `~/.config/opencode` | Override the OpenCode config directory. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Override the Claude Code config directory. |
| `CURSOR_CONFIG_DIR` | `~/.cursor` | Override the Cursor config directory. |
| `VSCODE_CONFIG_DIR` | `~/.config/Code/User` (Linux) / `~/Library/Application Support/Code/User` (macOS) | Override the VS Code config directory. |
| `CODEX_HOME` | `~/.codex` | Override the Codex home directory. |
| `GEMINI_CONFIG_DIR` | `~/.gemini` | Override the Gemini CLI config directory. |
| `OPENAI_MODEL` | `text-embedding-3-large` | Override the embedding model. |
| `OPENAI_SUMMARY_MODEL` | `gpt-5-nano` | Override the model used for session compaction (Compact for restart). |
| `CSM_SUMMARY_MAX_OUTPUT_TOKENS` | `5000` | Override the max output token budget for session compaction. |

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
│   ├── vscode-transcript-to-messages.ts  # VS Code JSONL transcript parser → FullMessage[]
│   ├── codex-session-to-messages.ts       # Codex JSONL session parser → FullMessage[]
│   ├── gemini-session-to-messages.ts      # Gemini CLI JSON session parser → FullMessage[]
│   ├── opencode-db-to-messages.ts        # OpenCode internal DB reader (fallback for -s mode)
│   ├── indexer.ts                        # Orchestrator: incremental indexing
│   ├── indexer-cli.ts                    # Node.js subprocess (called by OpenCode plugin)
│   ├── indexer-cli-claude.ts             # Node.js subprocess (called by Claude Code hook)
│   ├── indexer-cli-cursor.ts             # Node.js subprocess (called by Cursor stop hook)
│   ├── indexer-cli-vscode.ts            # Node.js subprocess (called by VS Code Stop hook)
│   ├── indexer-cli-codex.ts              # Node.js subprocess (called by Codex notify hook)
│   ├── indexer-cli-gemini.ts             # Node.js subprocess (called by Gemini CLI AfterAgent hook)
│   ├── cli.ts                            # install / status / uninstall / reset-db / query commands
│   ├── cli-query.ts                      # query command: semantic search from the terminal
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
    ├── vscode-transcript-to-messages.test.ts # Unit tests: VS Code JSONL parser
    ├── codex-session-to-messages.test.ts    # Unit tests: Codex JSONL parser
    ├── gemini-session-to-messages.test.ts   # Unit tests + e2e indexing: Gemini CLI parser
    ├── opencode-db-to-messages.test.ts      # Unit tests: OpenCode internal DB reader
    ├── cli-query.test.ts                    # Unit tests: query CLI command
    ├── e2e-claude.test.ts                   # End-to-end: Claude Code pipeline
    ├── e2e-cursor.test.ts                    # End-to-end: Cursor pipeline
    ├── e2e-opencode.test.ts                 # End-to-end: OpenCode pipeline
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
 ✓ tests/gemini-session-to-messages.test.ts         (5 tests)
 ✓ tests/opencode-db-to-messages.test.ts           (8 tests)
 ✓ tests/cli-query.test.ts                        (23 tests)
 ✓ tests/e2e-claude.test.ts                       (18 tests)
 ✓ tests/e2e-cursor.test.ts                        (8 tests)
 ✓ tests/e2e-opencode.test.ts                     (14 tests)
   Tests  249 passed
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

This removes the plugin, hooks, skill files, and MCP config entries for all tools (OpenCode, Claude Code, Cursor, VS Code, Codex, and Gemini CLI). The database is **not** removed automatically.

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

### VS Code transcript parsing

VS Code (with GitHub Copilot agent mode) supports the same hook lifecycle events as Claude Code and provides a `transcript_path` in its Stop hook payload. The parser (`vscode-transcript-to-messages.ts`) handles the JSONL transcript similarly to Claude Code's parser, with retry logic for potential race conditions between hook firing and transcript flush. The Stop hook requires **VS Code 1.109.3+** with **Chat: Use Hooks** enabled.

### Codex session parsing

Codex stores session transcripts as JSONL under `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread-id>.jsonl`. Its notify hook passes payload as a JSON string in `process.argv[2]` (not stdin). The parser (`codex-session-to-messages.ts`) indexes only clean `event_msg.user_message` user inputs and assistant `final_answer` messages, skipping system/developer injections and commentary messages.

### Gemini CLI session parsing

Gemini CLI provides `transcript_path` and `session_id` in the `AfterAgent` hook payload. The parser (`gemini-session-to-messages.ts`) reads the JSON session file, keeps `user` and `gemini` messages, maps `toolCalls[]` to `tool-invocation` parts, and derives a title from the first user prompt.

### Chunking strategy

- Heading-aware splitting — headings define semantic boundaries
- Max 1000 whitespace-tokenized words per chunk
- Sections below 150 words are merged with adjacent sections
- Sections above 1000 words are split with 10% overlap
- Each chunk gets a `[Session: Title > Section]` breadcrumb prefix injected before embedding, improving retrieval precision

### MCP server

The MCP server uses **stdio transport** — the simplest and most reliable transport for local use. It opens and closes the SQLite connection on each query (no persistent connection), making it safe to run alongside the indexer. The `query_sessions` tool supports filtering by `source` (`opencode`, `claude-code`, `cursor`, `vscode`, `codex`, `gemini-cli`), `project`, and date range (`fromDate`/`toDate`).

## License

MIT
