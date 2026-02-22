---
description: Search past OpenCode, Claude Code, Cursor, VS Code, and Codex sessions stored in the shared vector memory database
---

# code-session-memory

You have access to an MCP server called `code-session-memory` that automatically indexes all your past coding sessions — from **OpenCode**, **Claude Code**, **Cursor**, **VS Code**, and **Codex** — into a single shared local vector database. Every time a session completes a turn, the new messages are embedded and stored, giving you a searchable memory of your entire AI coding history across all tools.

## Available tools

### `query_sessions`

Semantically search across all indexed sessions to find past conversations, decisions, code snippets, or context.

**Parameters:**
- `queryText` *(required)*: A natural language description of what you are looking for.
- `project` *(optional)*: Filter results to a specific project directory path (e.g. `"/Users/me/myproject"`).
- `source` *(optional)*: Filter by tool — `"opencode"`, `"claude-code"`, `"cursor"`, `"vscode"`, or `"codex"`. Omit to search across all.
- `limit` *(optional, default 5)*: Number of results to return (1–20).
- `fromDate` *(optional)*: Return only chunks indexed on or after this date. ISO 8601, e.g. `"2026-02-01"` or `"2026-02-20T15:00:00Z"`.
- `toDate` *(optional)*: Return only chunks indexed on or before this date. ISO 8601, e.g. `"2026-02-20"`. Date-only values are treated as end-of-day UTC.

### `get_session_chunks`

Retrieve the full ordered content of a specific session message by URL.

**Parameters:**
- `sessionUrl` *(required)*: The `session://ses_xxx#msg_yyy` URL from a `query_sessions` result.
- `startIndex` *(optional)*: First chunk index to retrieve (0-based).
- `endIndex` *(optional)*: Last chunk index to retrieve (0-based, inclusive).

## When to use these tools

Use `query_sessions` proactively when:
- The user asks about past work: *"How did we implement the auth flow last week?"*
- You need context about a recurring problem: *"Have we seen this error before?"*
- The user references a previous decision: *"What did we decide about the database schema?"*
- You want to avoid repeating past mistakes or reinventing solutions

Use `get_session_chunks` to read the full context around a match from `query_sessions`.

## Example usage

```
# Find past work on a topic across all tools
query_sessions("authentication middleware implementation")

# Search only OpenCode sessions for a specific project
query_sessions("dark mode toggle", project="/Users/me/myapp", source="opencode")

# Search only Claude Code sessions
query_sessions("sqlite migration", source="claude-code")

# Search only VS Code sessions
query_sessions("refactoring utils", source="vscode")

# Search only Codex sessions
query_sessions("openapi mock server", source="codex")

# Search sessions from a specific date range
query_sessions("authentication middleware", fromDate="2026-02-01", toDate="2026-02-20")

# Get more context from a specific result
get_session_chunks("session://ses_abc123#msg_def456")
```

## Notes

- Sessions from OpenCode, Claude Code, Cursor, VS Code, and Codex are indexed into the **same** database.
- Indexing is automatic — no manual action needed.
- The database lives at `~/.local/share/code-session-memory/sessions.db`.
- Embeddings use OpenAI `text-embedding-3-large` (3072 dimensions).
