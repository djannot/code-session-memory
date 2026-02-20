#!/usr/bin/env node
/**
 * sessions sub-commands for code-session-memory CLI
 *
 *   sessions [list]              Browse sessions (interactive TUI)
 *   sessions list --filter       Browse with filter step first
 *   sessions print [id]          Print all chunks of a session to stdout
 *   sessions print --filter      Pick session interactively with filter, then print
 *   sessions delete [id]         Delete a session from the DB
 *   sessions delete --filter     Pick session interactively with filter, then delete
 */

import * as clack from "@clack/prompts";
import { resolveDbPath, openDatabase } from "./database";
import {
  listSessions,
  getSessionChunksOrdered,
  deleteSession,
  SessionRow,
  SessionFilter,
} from "./database";
import type { SessionSource } from "./types";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function bold(s: string): string   { return `\x1b[1m${s}\x1b[0m`; }
function green(s: string): string  { return `\x1b[32m${s}\x1b[0m`; }
function red(s: string): string    { return `\x1b[31m${s}\x1b[0m`; }
function dim(s: string): string    { return `\x1b[2m${s}\x1b[0m`; }
function cyan(s: string): string   { return `\x1b[36m${s}\x1b[0m`; }
function yellow(s: string): string { return `\x1b[33m${s}\x1b[0m`; }

function fmtDate(unixMs: number): string {
  if (!unixMs) return dim("unknown date");
  return new Date(unixMs).toISOString().slice(0, 10);
}

function fmtSource(source: string): string {
  return source === "opencode" ? cyan("opencode") : yellow("claude-code");
}

function fmtTitle(title: string): string {
  return title || dim("(untitled)");
}

function fmtProject(project: string): string {
  if (!project) return dim("—");
  const parts = project.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 2 ? dim("…/" + parts.slice(-2).join("/")) : dim(project);
}

function hr(char = "─", width = 72): string {
  return char.repeat(width);
}

// ---------------------------------------------------------------------------
// DB helpers (open/close around each command)
// ---------------------------------------------------------------------------

function withDb<T>(fn: (db: ReturnType<typeof openDatabase>) => T): T {
  const dbPath = resolveDbPath();
  const db = openDatabase({ dbPath });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Label builder for the session picker
// ---------------------------------------------------------------------------

function sessionLabel(s: SessionRow): string {
  const date   = fmtDate(s.updated_at);
  const chunks = `${s.chunk_count} chunk${s.chunk_count !== 1 ? "s" : ""}`;
  const title  = fmtTitle(s.session_title).padEnd(40);
  return `${title}  ${date}  ${chunks}`;
}

function sessionHint(s: SessionRow): string {
  return `${fmtSource(s.source)}  ${fmtProject(s.project)}`;
}

// ---------------------------------------------------------------------------
// Filter step (shown when --filter flag is present)
// ---------------------------------------------------------------------------

async function runFilterStep(): Promise<SessionFilter> {
  clack.intro(bold("Filter sessions"));

  const sourceAnswer = await clack.select<string>({
    message: "Source",
    options: [
      { value: "all",         label: "All tools" },
      { value: "opencode",    label: "OpenCode" },
      { value: "claude-code", label: "Claude Code" },
    ],
    initialValue: "all",
  });
  if (clack.isCancel(sourceAnswer)) { clack.cancel("Cancelled."); process.exit(0); }

  const dateAnswer = await clack.select<string>({
    message: "Date range",
    options: [
      { value: "all",    label: "All time" },
      { value: "7d",     label: "Last 7 days" },
      { value: "30d",    label: "Last 30 days" },
      { value: "90d",    label: "Last 90 days" },
      { value: "recent", label: "Last N days",    hint: "enter a number" },
      { value: "older",  label: "Older than N days", hint: "enter a number" },
    ],
    initialValue: "all",
  });
  if (clack.isCancel(dateAnswer)) { clack.cancel("Cancelled."); process.exit(0); }

  const filter: SessionFilter = {};

  if (sourceAnswer !== "all") {
    filter.source = sourceAnswer as SessionSource;
  }

  const nowMs  = Date.now();
  const DAY_MS = 86400 * 1000;

  if (dateAnswer === "7d") {
    filter.fromDate = nowMs - 7 * DAY_MS;
  } else if (dateAnswer === "30d") {
    filter.fromDate = nowMs - 30 * DAY_MS;
  } else if (dateAnswer === "90d") {
    filter.fromDate = nowMs - 90 * DAY_MS;
  } else if (dateAnswer === "recent") {
    const nAnswer = await clack.text({
      message: "Show sessions from the last how many days?",
      placeholder: "14",
      validate(v) {
        if (!v || isNaN(Number(v)) || Number(v) <= 0) return "Please enter a positive number.";
      },
    });
    if (clack.isCancel(nAnswer)) { clack.cancel("Cancelled."); process.exit(0); }
    filter.fromDate = nowMs - Number(nAnswer) * DAY_MS;
  } else if (dateAnswer === "older") {
    const nAnswer = await clack.text({
      message: "Show sessions older than how many days?",
      placeholder: "30",
      validate(v) {
        if (!v || isNaN(Number(v)) || Number(v) <= 0) return "Please enter a positive number.";
      },
    });
    if (clack.isCancel(nAnswer)) { clack.cancel("Cancelled."); process.exit(0); }
    filter.toDate = nowMs - Number(nAnswer) * DAY_MS;
  }

  return filter;
}

// ---------------------------------------------------------------------------
// Shared session picker
// Returns the chosen SessionRow, or null if the user cancelled / exited.
// When withFilter is true, runs the filter step first.
// ---------------------------------------------------------------------------

async function pickSession(withFilter: boolean): Promise<SessionRow | null> {
  let filter: SessionFilter = {};
  if (withFilter) {
    filter = await runFilterStep();
    console.log();
  }

  const sessions = withDb((db) => listSessions(db, filter));

  if (sessions.length === 0) {
    clack.log.warn("No sessions match the current filter.");
    return null;
  }

  const chosen = await clack.select<string | "__cancel__">({
    message: `${sessions.length} session${sessions.length !== 1 ? "s" : ""}${withFilter ? dim("  (filtered)") : ""}  — pick one`,
    options: [
      ...sessions.map((s) => ({
        value: s.session_id,
        label: sessionLabel(s),
        hint:  sessionHint(s),
      })),
      { value: "__cancel__", label: dim("Cancel") },
    ],
    maxItems: 12,
  });

  if (clack.isCancel(chosen) || chosen === "__cancel__") return null;
  return sessions.find((s) => s.session_id === chosen) ?? null;
}

// ---------------------------------------------------------------------------
// Action loop for a selected session (used by sessions list)
// ---------------------------------------------------------------------------

async function sessionActionLoop(session: SessionRow): Promise<"back" | "exit"> {
  while (true) {
    clack.log.message(
      [
        `${bold(fmtTitle(session.session_title))}`,
        `${fmtSource(session.source)}  ${fmtDate(session.updated_at)}  ${session.chunk_count} chunks`,
        `Project: ${session.project || dim("—")}`,
        `ID: ${dim(session.session_id)}`,
      ].join("\n"),
      { symbol: "○" },
    );

    const action = await clack.select<string>({
      message: "What would you like to do?",
      options: [
        { value: "print",  label: "Print session",  hint: "output all chunks to stdout" },
        { value: "delete", label: "Delete session",  hint: "remove from DB" },
        { value: "back",   label: "Back to list" },
      ],
    });

    if (clack.isCancel(action) || action === "back") return "back";

    if (action === "print") {
      clack.outro(dim("Printing session…"));
      printSession(session.session_id);
      return "exit";
    }

    if (action === "delete") {
      const confirmed = await clack.confirm({
        message: `Delete "${fmtTitle(session.session_title)}" (${session.chunk_count} chunks)?`,
        initialValue: false,
      });
      if (clack.isCancel(confirmed) || !confirmed) {
        clack.log.info("Deletion cancelled.");
        continue;
      }

      const deleted = withDb((db) => deleteSession(db, session.session_id));
      clack.log.success(`Deleted ${deleted} chunks.`);
      clack.log.warn(
        "Note: if this session's source files still exist, it will be re-indexed on the next agent turn.",
      );
      return "back";
    }
  }
}

// ---------------------------------------------------------------------------
// sessions list
// ---------------------------------------------------------------------------

export async function cmdSessionsList(args: string[]): Promise<void> {
  const withFilter = args.includes("--filter");

  if (!withFilter) {
    clack.intro(bold("Sessions"));
  }

  // Main browse loop — re-shown after back/delete so the user can keep browsing
  let filter: SessionFilter = {};
  let filterResolved = false;

  while (true) {
    // Run filter step once (first iteration only, if --filter was passed)
    if (withFilter && !filterResolved) {
      filter = await runFilterStep();
      filterResolved = true;
      console.log();
    }

    const sessions = withDb((db) => listSessions(db, filter));

    if (sessions.length === 0) {
      clack.log.warn("No sessions match the current filter.");
      clack.outro("Done.");
      return;
    }

    const chosen = await clack.select<string | "__exit__">({
      message: `${sessions.length} session${sessions.length !== 1 ? "s" : ""}  ${withFilter ? dim("(filtered)") : ""}`,
      options: [
        ...sessions.map((s) => ({
          value: s.session_id,
          label: sessionLabel(s),
          hint:  sessionHint(s),
        })),
        { value: "__exit__", label: dim("Exit") },
      ],
      maxItems: 12,
    });

    if (clack.isCancel(chosen) || chosen === "__exit__") {
      clack.outro("Done.");
      return;
    }

    const session = sessions.find((s) => s.session_id === chosen)!;
    const result = await sessionActionLoop(session);
    if (result === "exit") return;
    // result === "back" → loop again, refresh session list
  }
}

// ---------------------------------------------------------------------------
// sessions print [id]
// ---------------------------------------------------------------------------

export async function cmdSessionsPrint(sessionId?: string, args: string[] = []): Promise<void> {
  const withFilter = args.includes("--filter");

  if (!sessionId) {
    // No ID given — launch interactive picker
    clack.intro(bold("Print session"));
    const session = await pickSession(withFilter);
    if (!session) {
      clack.outro("Cancelled.");
      return;
    }
    clack.outro(dim("Printing session…"));
    printSession(session.session_id);
    return;
  }

  printSession(sessionId);
}

function printSession(sessionId: string): void {
  const { session, chunks } = withDb((db) => {
    const rows    = listSessions(db, {});
    const session = rows.find((s) => s.session_id === sessionId);
    const chunks  = getSessionChunksOrdered(db, sessionId);
    return { session, chunks };
  });

  if (!session && chunks.length === 0) {
    console.error(`No session found with ID: ${sessionId}`);
    process.exit(1);
  }

  const useTty = process.stdout.isTTY;
  const b = (s: string) => useTty ? bold(s)   : s;
  const d = (s: string) => useTty ? dim(s)    : s;
  const c = (s: string) => useTty ? cyan(s)   : s;
  const y = (s: string) => useTty ? yellow(s) : s;

  const title   = session?.session_title || "(untitled)";
  const source  = session?.source        || "unknown";
  const date    = session ? fmtDate(session.updated_at) : "unknown";
  const project = session?.project       || "—";

  console.log(hr());
  console.log(`${b("Session:")} ${title}`);
  console.log(`${b("Source:")}  ${source === "opencode" ? c(source) : y(source)}  ${d(date)}`);
  console.log(`${b("Project:")} ${project}`);
  console.log(`${b("ID:")}      ${d(sessionId)}`);
  console.log(`${b("Chunks:")}  ${chunks.length}`);
  console.log(hr());

  const total = chunks.length;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    console.log();
    console.log(b(`## Chunk ${i + 1}/${total}`) + `  ${d("—")}  Section: ${chunk.section || d("(none)")}`);
    console.log();
    console.log(chunk.content);
  }

  console.log();
  console.log(hr());
}

// ---------------------------------------------------------------------------
// sessions delete [id]
// ---------------------------------------------------------------------------

export async function cmdSessionsDelete(sessionId?: string, args: string[] = []): Promise<void> {
  const withFilter = args.includes("--filter");

  clack.intro(bold("Delete session"));

  let session: SessionRow | null = null;

  if (!sessionId) {
    // No ID given — launch interactive picker
    session = await pickSession(withFilter);
    if (!session) {
      clack.outro("Cancelled.");
      return;
    }
  } else {
    session = withDb((db) => {
      const rows = listSessions(db, {});
      return rows.find((s) => s.session_id === sessionId) ?? null;
    });

    if (!session) {
      console.error(`No session found with ID: ${sessionId}`);
      process.exit(1);
    }
  }

  clack.log.message(
    [
      `${bold(fmtTitle(session.session_title))}`,
      `${fmtSource(session.source)}  ${fmtDate(session.updated_at)}  ${session.chunk_count} chunks`,
      `Project: ${session.project || dim("—")}`,
      `ID: ${dim(session.session_id)}`,
    ].join("\n"),
    { symbol: "○" },
  );

  const confirmed = await clack.confirm({
    message: `Delete this session (${session.chunk_count} chunks)?`,
    initialValue: false,
  });

  if (clack.isCancel(confirmed) || !confirmed) {
    clack.cancel("Deletion cancelled — database was not modified.");
    return;
  }

  const deleted = withDb((db) => deleteSession(db, session!.session_id));
  clack.log.success(`Deleted ${deleted} chunks.`);
  clack.log.warn(
    "Note: if this session's source files still exist, it will be re-indexed on the next agent turn.",
  );
  clack.outro("Done.");
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function sessionsHelp(): void {
  const b = (s: string) => `\x1b[1m${s}\x1b[0m`;
  console.log(`
${b("sessions")} — Browse, inspect, and delete indexed sessions

${b("Usage:")}
  npx code-session-memory sessions                Browse sessions interactively
  npx code-session-memory sessions --filter       Apply source/date filters before browsing
  npx code-session-memory sessions list           Same as above (explicit sub-command)
  npx code-session-memory sessions list --filter  Same with filter step

  npx code-session-memory sessions print          Pick a session interactively, then print
  npx code-session-memory sessions print --filter Pick with filter, then print
  npx code-session-memory sessions print <id>     Print all chunks of a session directly

  npx code-session-memory sessions delete         Pick a session interactively, then delete
  npx code-session-memory sessions delete --filter Pick with filter, then delete
  npx code-session-memory sessions delete <id>    Delete a session directly

${b("Filter options")} (with --filter):
  Source:     All tools / OpenCode / Claude Code
  Date range: Last 7 / 30 / 90 days, last N days (custom), older than N days (custom)

${b("Notes:")}
  - Deleting a session only removes it from the DB. If the source files still
    exist, the session will be re-indexed on the next agent turn.
  - "sessions print" output is pipe-friendly (no ANSI when stdout is not a TTY).
`);
}

// ---------------------------------------------------------------------------
// Entry point: dispatch sessions sub-commands
// ---------------------------------------------------------------------------

export async function cmdSessions(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "list";

  // Help flag anywhere in argv
  if (argv.includes("--help") || argv.includes("-h")) {
    sessionsHelp();
    return;
  }

  switch (sub) {
    case "list":
      await cmdSessionsList(argv.slice(1));
      break;

    case "print": {
      // argv[1] is either an ID or a flag (--filter) or absent
      const maybeId  = argv[1] && !argv[1].startsWith("-") ? argv[1] : undefined;
      const restArgs = maybeId ? argv.slice(2) : argv.slice(1);
      await cmdSessionsPrint(maybeId, restArgs);
      break;
    }

    case "delete": {
      const maybeId  = argv[1] && !argv[1].startsWith("-") ? argv[1] : undefined;
      const restArgs = maybeId ? argv.slice(2) : argv.slice(1);
      await cmdSessionsDelete(maybeId, restArgs);
      break;
    }

    default:
      // Treat unknown first arg as implicit "list" (e.g. `sessions --filter`)
      if (sub.startsWith("-")) {
        await cmdSessionsList(argv);
      } else {
        console.error(`Unknown sessions sub-command: ${sub}`);
        console.error('Run "npx code-session-memory sessions --help" for usage.');
        process.exit(1);
      }
  }
}
