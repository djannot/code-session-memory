# opencode-memory

Automatic vector memory for [OpenCode](https://opencode.ai) sessions.

Every time the AI agent finishes its turn, `opencode-memory` automatically indexes the new messages into a local [sqlite-vec](https://github.com/asg017/sqlite-vec) vector database. Past sessions become semantically searchable — both by the AI agent (via the MCP server) and by you.

## How it works

```
Agent finishes turn
       │
       ▼
OpenCode plugin (session.idle event)
       │  uses OpenCode SDK to fetch new messages
       ▼
session-to-md  →  converts messages to markdown
       │
       ▼
chunker        →  heading-aware chunks (≤1000 tokens, 10% overlap)
       │
       ▼
embedder       →  OpenAI text-embedding-3-large (3072 dims)
       │
       ▼
sqlite-vec DB  →  ~/.local/share/opencode-memory/sessions.db
       │
       ▼
MCP server     →  query_sessions / get_session_chunks tools
```

Only **new messages** are indexed on each turn — previously indexed messages are skipped (tracked via `sessions_meta` table). This makes each indexing pass fast, even in long sessions.

## Installation

### Prerequisites

- Node.js ≥ 18
- An OpenAI API key (for `text-embedding-3-large`)
- OpenCode installed

### Install

```bash
npm install -g opencode-memory
# or run without installing:
npx opencode-memory install
```

The `install` command:
1. Creates `~/.local/share/opencode-memory/sessions.db` and initialises the schema
2. Copies the plugin to `~/.config/opencode/plugins/opencode-memory.ts`
3. Copies the skill to `~/.config/opencode/skills/opencode-memory.md`
4. Prints the MCP server config snippet to add to your `opencode.json`

### Configure MCP server

After running `install`, add the MCP server to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "opencode-memor": {
      "type": "local",
      "command": ["node", "/Users/denisjannot/Documents/ai/opencode-memory/dist/mcp/index.js"],
      "environment": {
        "OPENAI_API_KEY": "${OPENAI_API_KEY}"
      }
    }
  }
}
```

The exact path is printed by `npx opencode-memory install`.

### Set your API key

```bash
export OPENAI_API_KEY=sk-...
```

Add this to your shell profile (`.bashrc`, `.zshrc`, etc.) so it's always available.

## Usage

Once installed, memory indexing is **fully automatic**. No further action needed — sessions are indexed as you use OpenCode.

### Verify installation

```bash
npx opencode-memory status
```

Output:
```
opencode-memory status

  ✓  Database       ~/.local/share/opencode-memory/sessions.db
  ✓  Plugin         ~/.config/opencode/plugins/opencode-memory.ts
  ✓  Skill          ~/.config/opencode/skills/opencode-memory.md
  ✓  MCP server     /path/to/dist/mcp/index.js

  Indexed chunks:   1842
  Sessions tracked: 47

  All components installed.
```

### MCP tools

The agent can use two MCP tools (and will automatically via the installed skill):

#### `query_sessions`

Semantic search across all indexed sessions.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `queryText` | string | yes | Natural language query |
| `project` | string | no | Filter by project directory path |
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
| `OPENCODE_MEMORY_DB_PATH` | `~/.local/share/opencode-memory/sessions.db` | Override the database path. |
| `OPENCODE_CONFIG_DIR` | `~/.config/opencode` | Override the OpenCode config directory (affects where plugin/skill are installed). |
| `OPENAI_MODEL` | `text-embedding-3-large` | Override the embedding model. |

### Database path

The default database path works on both **macOS** and **Linux**. On macOS, `~/.local/share` is used for cross-platform consistency (rather than `~/Library/Application Support`).

To change it:
```bash
export OPENCODE_MEMORY_DB_PATH=/custom/path/sessions.db
npx opencode-memory install
```

## Project structure

```
opencode-memory/
├── src/
│   ├── types.ts          # Shared TypeScript types
│   ├── database.ts       # SQLite-vec: init, insert, query
│   ├── chunker.ts        # Heading-aware markdown chunker
│   ├── embedder.ts       # OpenAI embeddings (batched)
│   ├── session-to-md.ts  # SDK messages → markdown string
│   ├── indexer.ts        # Orchestrator: incremental indexing
│   └── cli.ts            # install / status / uninstall commands
├── mcp/
│   ├── server.ts         # MCP query handlers (testable, injected deps)
│   └── index.ts          # MCP stdio server entry point
├── plugin/
│   └── memory.ts         # OpenCode plugin (session.idle hook)
├── skill/
│   └── memory.md         # OpenCode skill (agent instructions)
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
 ✓ tests/chunker.test.ts      (15 tests)
 ✓ tests/mcp-server.test.ts   (13 tests)
 ✓ tests/session-to-md.test.ts (18 tests)
 ✓ tests/embedder.test.ts      (9 tests)
 ✓ tests/database.test.ts     (25 tests)
 ✓ tests/indexer.test.ts       (8 tests)
   Tests  88 passed
```

## Uninstall

```bash
npx opencode-memory uninstall
```

This removes the plugin and skill files. The database is **not** removed automatically.

To also remove the database:
```bash
rm ~/.local/share/opencode-memory/sessions.db
```

## Architecture notes

### Incremental indexing

The plugin fires on every `session.idle` event (i.e., every agent turn). To avoid re-processing the entire session history each time, the indexer:

1. Reads `last_indexed_message_id` from the `sessions_meta` table
2. Skips all messages up to and including that ID
3. Processes only the new messages
4. Updates `last_indexed_message_id` after success

This makes each indexing pass O(new messages) rather than O(all messages).

### Chunking strategy

Adapted from [doc2vec](https://github.com/denisjannot/doc2vec):
- Heading-aware splitting — headings define semantic boundaries
- Max 1000 whitespace-tokenized words per chunk
- Sections below 150 words are merged with adjacent sections
- Sections above 1000 words are split with 10% overlap
- Each chunk gets a `[Session: Title > Section]` breadcrumb prefix injected before embedding, improving retrieval precision

### MCP server

The MCP server uses **stdio transport** — the simplest and most reliable transport for local use. It opens and closes the SQLite connection on each query (no persistent connection), making it safe to run alongside the indexer plugin.

## License

MIT
