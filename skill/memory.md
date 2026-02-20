---
description: Search past OpenCode sessions stored in the vector memory database
---

# opencode-session-memory

You have access to an MCP server called `opencode-session-memory` that automatically indexes all your past OpenCode sessions into a local vector database. Every time a session completes a turn, the new messages are embedded and stored — giving you a searchable memory of your entire AI coding history.

## Available tools

### `query_sessions`

Semantically search across all indexed sessions to find past conversations, decisions, code snippets, or context.

**Parameters:**
- `queryText` *(required)*: A natural language description of what you are looking for. Be specific — describe the topic, technology, decision, or problem.
- `project` *(optional)*: Filter results to a specific project directory path (e.g. `"/Users/me/myproject"`). Omit to search across all projects.
- `limit` *(optional, default 5)*: Number of results to return (1–20).

**Returns:** Ranked list of matching chunks, each with:
- Content of the chunk (includes contextual prefix like `[Session: Title > Section]`)
- Similarity distance (lower = more similar)
- Session URL in `session://ses_xxx#msg_yyy` format
- Section and chunk position within the message

### `get_session_chunks`

Retrieve the full ordered content of a specific session message. Use this after `query_sessions` to get the complete context around a match — e.g. to read the full assistant response or user request that surrounded a relevant snippet.

**Parameters:**
- `sessionUrl` *(required)*: The `session://ses_xxx#msg_yyy` URL from a `query_sessions` result.
- `startIndex` *(optional)*: First chunk index to retrieve (0-based). Omit to start from the beginning.
- `endIndex` *(optional)*: Last chunk index to retrieve (0-based, inclusive). Omit to read to the end.

**Returns:** All chunks of the message in order, with content and section info.

## When to use these tools

Use `query_sessions` proactively when:
- The user asks about past work: *"How did we implement the auth flow last week?"*
- You need context about a recurring problem: *"Have we seen this error before?"*
- The user references a previous decision: *"What did we decide about the database schema?"*
- You want to avoid repeating past mistakes or reinventing solutions

Use `get_session_chunks` when:
- A `query_sessions` result is a snippet but you need the full message for context
- You want to read a complete assistant response or explanation from a past session

## Example usage

```
# Find past work on a topic
query_sessions("authentication middleware implementation", project="/Users/me/myapi")

# Get more context from a specific result
get_session_chunks("session://ses_abc123#msg_def456")

# Search for a past error discussion
query_sessions("sqlite-vec dimension mismatch error")

# Find how a feature was planned
query_sessions("dark mode toggle implementation plan")
```

## Notes

- Sessions are indexed automatically after each agent turn — no manual action needed.
- Only messages from the current and past sessions are indexed; future messages are indexed as they happen.
- The database lives at `~/.local/share/opencode-memory/sessions.db`.
- Embeddings use OpenAI `text-embedding-3-large` (3072 dimensions).
