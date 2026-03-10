---
name: code-session-memory
description: Search past OpenCode, Claude Code, Cursor, VS Code, Codex, and Gemini CLI sessions stored in the shared vector memory database
---

# code-session-memory

You have access to an MCP server called `code-session-memory` that automatically indexes all your past coding sessions — from **OpenCode**, **Claude Code**, **Cursor**, **VS Code**, **Codex**, and **Gemini CLI** — into a single shared local vector database. Every time a session completes a turn, the new messages are embedded and stored, giving you a searchable memory of your entire AI coding history across all tools.

## Available tools

### `query_sessions`

Semantically search across all indexed sessions to find past conversations, decisions, code snippets, or context.

**Parameters:**
- `queryText` *(required)*: A natural language description of what you are looking for.
- `project` *(optional)*: Filter results to a specific project directory path (e.g. `"/Users/me/myproject"`).
- `source` *(optional)*: Filter by tool — `"opencode"`, `"claude-code"`, `"cursor"`, `"vscode"`, `"codex"`, or `"gemini-cli"`. Omit to search across all.
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

**IMPORTANT:** `query_sessions` is a powerful research tool that gives you instant access to months of coding decisions, solutions, and context across all AI coding tools. Use it proactively as part of your standard workflow, not just when explicitly asked.

### Required searches (always check session memory first):

Before starting work, **ALWAYS** search `query_sessions` when:

1. **Working on existing features** - Search for the feature name, related components, or similar functionality to understand past decisions and implementation patterns
2. **Debugging or investigating errors** - Search for the error message, stack trace keywords, or related component to see if this has been solved before
3. **User mentions "we did something similar before"** - Even vague references to past work should trigger a search
4. **Adding to or modifying unfamiliar code** - Search for the file path, component name, or related concepts to understand context and history
5. **User asks "how does X work?"** - Search session memory first before reading code—past conversations often have better explanations than raw code

### Proactive searches (use your judgment):

Consider searching `query_sessions` when:

- Starting a new task in an unfamiliar area of the codebase
- The user's request seems like it might have been discussed before
- You're about to propose a solution—check if similar approaches were tried (and why they succeeded/failed)
- Making architectural or design decisions—see what patterns have been established
- Encountering unexpected behavior—past sessions may reveal why things are designed this way
- You need to understand project conventions or preferences

### Search strategy:

- **Start broad, then narrow**: Begin with general terms, then refine with project/date filters if needed
- **Use natural language**: The search is semantic—"why did we choose postgres over sqlite" works better than keywords
- **Check recent first**: Use `fromDate` to prioritize recent decisions (e.g., last 30-90 days)
- **Project-scoped**: Add `project="<current-directory>"` to focus on relevant sessions

### Example workflow:

```
User: "Can you add caching to the API endpoints?"

# ❌ Bad: Jump straight into reading code
Read api/handlers.go

# ✅ Good: Search session memory first
query_sessions("API caching implementation", project="/home/user/myproject")
query_sessions("redis cache endpoints")
# Then proceed based on what you find
```

Use `get_session_chunks` to read the full context around any relevant match from `query_sessions`.

**Remember:** Session memory is searchable across ALL your AI coding sessions (OpenCode, Claude Code, Cursor, VS Code, Codex, Gemini CLI). A 5-second search can save you 5 minutes of code reading or prevent repeating past mistakes.

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

# Search only Gemini CLI sessions
query_sessions("hook payload format", source="gemini-cli")

# Search sessions from a specific date range
query_sessions("authentication middleware", fromDate="2026-02-01", toDate="2026-02-20")

# Get more context from a specific result
get_session_chunks("session://ses_abc123#msg_def456")
```

## Notes

- Sessions from OpenCode, Claude Code, Cursor, VS Code, Codex, and Gemini CLI are indexed into the **same** database.
- Indexing is automatic — no manual action needed.
- The database lives at `~/.local/share/code-session-memory/sessions.db`.
- Embeddings use OpenAI `text-embedding-3-large` (3072 dimensions).