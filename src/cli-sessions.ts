#!/usr/bin/env node
/**
 * sessions sub-commands for code-session-memory CLI
 *
 *   sessions [list]              Browse sessions (3-level tree: source → date → session)
 *   sessions print [id]          Print all chunks of a session to stdout
 *   sessions delete [id]         Delete a session from the DB
 *   sessions purge [--days <n>] [--yes]  Delete all sessions older than N days
 */

import * as clack from "@clack/prompts";
import { resolveDbPath, openDatabase } from "./database";
import {
  listSessions,
  getSessionChunksOrdered,
  deleteSession,
  deleteSessionsOlderThan,
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
  if (source === "opencode")    return cyan("opencode");
  if (source === "cursor")      return green("cursor");
  return yellow("claude-code");
}

function fmtTitle(title: string): string {
  return title || dim("(untitled)");
}

function fmtProject(project: string): string {
  if (!project) return dim("—");
  const parts = project.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length > 2 ? dim("…/" + parts.slice(-2).join("/")) : dim(project);
}

function fmtChunks(n: number): string {
  return `${n} chunk${n !== 1 ? "s" : ""}`;
}

function hr(char = "─", width = 72): string {
  return char.repeat(width);
}

// ---------------------------------------------------------------------------
// DB helpers
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
// Label builders
// ---------------------------------------------------------------------------

function sessionLabel(s: SessionRow): string {
  const chunks = fmtChunks(s.chunk_count);
  const title  = fmtTitle(s.session_title).padEnd(40);
  return `${title}  ${chunks}`;
}

function sessionHint(s: SessionRow): string {
  return `${fmtSource(s.source)}  ${fmtProject(s.project)}`;
}

// ---------------------------------------------------------------------------
// Tree picker: source → date → session
//
// Returns the chosen SessionRow, or null if the user exited/cancelled.
// ---------------------------------------------------------------------------

type PickResult = SessionRow | null;

async function pickSessionTree(allSessions: SessionRow[]): Promise<PickResult> {
  if (allSessions.length === 0) return null;

  // ── Level 1: choose source ──────────────────────────────────────────────

  // Group by source, count sessions + chunks
  const sourceMap = new Map<string, SessionRow[]>();
  for (const s of allSessions) {
    if (!sourceMap.has(s.source)) sourceMap.set(s.source, []);
    sourceMap.get(s.source)!.push(s);
  }

  // Sort sources by session count descending
  const sources = [...sourceMap.entries()].sort((a, b) => b[1].length - a[1].length);

  const sourceOptions = [
    ...sources.map(([src, rows]) => ({
      value: src,
      label: sourceLabelText(src),
      hint:  `${rows.length} session${rows.length !== 1 ? "s" : ""}  ${fmtChunks(rows.reduce((n, r) => n + r.chunk_count, 0))}`,
    })),
    { value: "__all__",  label: dim("All sessions"), hint: `${allSessions.length} total` },
    { value: "__exit__", label: dim("Exit") },
  ];

  const srcChoice = await clack.select<string>({
    message: "Source",
    options: sourceOptions,
    maxItems: 8,
  });

  if (clack.isCancel(srcChoice) || srcChoice === "__exit__") return null;

  const filteredBySrc: SessionRow[] =
    srcChoice === "__all__" ? allSessions : sourceMap.get(srcChoice)!;

  // ── Level 2: choose date (skip if only one date or "All sessions") ──────

  let filteredByDate: SessionRow[];

  if (srcChoice === "__all__") {
    // Skip date level — go straight to all sessions
    filteredByDate = filteredBySrc;
  } else {
    // Group by YYYY-MM-DD
    const dateMap = new Map<string, SessionRow[]>();
    for (const s of filteredBySrc) {
      const d = fmtDate(s.updated_at);
      if (!dateMap.has(d)) dateMap.set(d, []);
      dateMap.get(d)!.push(s);
    }

    if (dateMap.size === 1) {
      // Only one date — skip level 2
      filteredByDate = filteredBySrc;
    } else {
      const dates = [...dateMap.entries()].sort((a, b) => b[0].localeCompare(a[0]));
      const dateOptions = [
        ...dates.map(([date, rows]) => ({
          value: date,
          label: date,
          hint:  `${rows.length} session${rows.length !== 1 ? "s" : ""}`,
        })),
        { value: "__back__", label: dim("Back") },
      ];

      const dateChoice = await clack.select<string>({
        message: `Date  ${dim("(" + sourceLabelText(srcChoice) + ")")}`,
        options: dateOptions,
        maxItems: 10,
      });

      if (clack.isCancel(dateChoice) || dateChoice === "__back__") {
        // Go back to level 1
        return pickSessionTree(allSessions);
      }

      filteredByDate = dateMap.get(dateChoice)!;
    }
  }

  // ── Level 3: choose session ──────────────────────────────────────────────

  const sessionOptions = [
    ...filteredByDate.map((s) => ({
      value: s.session_id,
      label: sessionLabel(s),
      hint:  sessionHint(s),
    })),
    { value: "__back__", label: dim("Back") },
  ];

  const backLabel = srcChoice === "__all__"
    ? "Source"
    : dateMap_size(filteredBySrc) === 1 ? "Source" : "Date";

  const sessionOptions2 = sessionOptions.map((o) =>
    o.value === "__back__" ? { ...o, hint: `back to ${backLabel}` } : o,
  );

  const sessionChoice = await clack.select<string>({
    message: srcChoice === "__all__"
      ? `Session  ${dim("(all sources)")}`
      : `Session  ${dim("(" + sourceLabelText(srcChoice) + ")")}`,
    options: sessionOptions2,
    maxItems: 12,
  });

  if (clack.isCancel(sessionChoice) || sessionChoice === "__back__") {
    if (srcChoice === "__all__" || dateMap_size(filteredBySrc) === 1) {
      // Back to level 1
      return pickSessionTree(allSessions);
    }
    // Back to level 2 — re-run from source choice but pre-select the date level
    // Simplest: restart from level 1 (preserves the loop invariant)
    return pickSessionTree(allSessions);
  }

  return filteredByDate.find((s) => s.session_id === sessionChoice) ?? null;
}

// Helper: plain text source label (no ANSI) for use in hints/messages
function sourceLabelText(source: string): string {
  if (source === "opencode")    return "OpenCode";
  if (source === "cursor")      return "Cursor";
  if (source === "claude-code") return "Claude Code";
  return source;
}

// Helper to count unique dates in a session list without capturing dateMap
function dateMap_size(sessions: SessionRow[]): number {
  return new Set(sessions.map((s) => fmtDate(s.updated_at))).size;
}

// ---------------------------------------------------------------------------
// Action loop for a selected session (used by sessions list)
// ---------------------------------------------------------------------------

async function sessionActionLoop(session: SessionRow): Promise<"back" | "exit"> {
  while (true) {
    clack.log.message(
      [
        `${bold(fmtTitle(session.session_title))}`,
        `${fmtSource(session.source)}  ${fmtDate(session.updated_at)}  ${fmtChunks(session.chunk_count)}`,
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
        message: `Delete "${fmtTitle(session.session_title)}" (${fmtChunks(session.chunk_count)})?`,
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

export async function cmdSessionsList(): Promise<void> {
  clack.intro(bold("Sessions"));

  while (true) {
    const sessions = withDb((db) => listSessions(db));

    if (sessions.length === 0) {
      clack.log.warn("No sessions indexed yet.");
      clack.outro("Done.");
      return;
    }

    const session = await pickSessionTree(sessions);

    if (!session) {
      clack.outro("Done.");
      return;
    }

    const result = await sessionActionLoop(session);
    if (result === "exit") return;
    // result === "back" → loop, refresh session list and restart tree
  }
}

// ---------------------------------------------------------------------------
// Shared session picker (for print / delete sub-commands)
// ---------------------------------------------------------------------------

async function pickSession(): Promise<SessionRow | null> {
  const sessions = withDb((db) => listSessions(db));

  if (sessions.length === 0) {
    clack.log.warn("No sessions indexed yet.");
    return null;
  }

  return pickSessionTree(sessions);
}

// ---------------------------------------------------------------------------
// sessions print [id]
// ---------------------------------------------------------------------------

export async function cmdSessionsPrint(sessionId?: string): Promise<void> {
  if (!sessionId) {
    clack.intro(bold("Print session"));
    const session = await pickSession();
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
  const fmtSrc = (src: string) => {
    if (!useTty) return src;
    return fmtSource(src);
  };

  const title   = session?.session_title || "(untitled)";
  const source  = session?.source        || "unknown";
  const date    = session ? fmtDate(session.updated_at) : "unknown";
  const project = session?.project       || "—";

  console.log(hr());
  console.log(`${b("Session:")} ${title}`);
  console.log(`${b("Source:")}  ${fmtSrc(source)}  ${d(date)}`);
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

export async function cmdSessionsDelete(sessionId?: string): Promise<void> {
  clack.intro(bold("Delete session"));

  let session: SessionRow | null = null;

  if (!sessionId) {
    session = await pickSession();
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
      `${fmtSource(session.source)}  ${fmtDate(session.updated_at)}  ${fmtChunks(session.chunk_count)}`,
      `Project: ${session.project || dim("—")}`,
      `ID: ${dim(session.session_id)}`,
    ].join("\n"),
    { symbol: "○" },
  );

  const confirmed = await clack.confirm({
    message: `Delete this session (${fmtChunks(session.chunk_count)})?`,
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
// sessions purge [--days <n>] [--yes]
// ---------------------------------------------------------------------------

export async function cmdSessionsPurge(args: string[]): Promise<void> {
  const DAY_MS = 86400 * 1000;

  // Parse --days <n>
  let days: number | undefined;
  const daysIdx = args.indexOf("--days");
  if (daysIdx !== -1 && args[daysIdx + 1]) {
    const parsed = Number(args[daysIdx + 1]);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      console.error("--days must be a positive integer");
      process.exit(1);
    }
    days = parsed;
  }

  const skipConfirm = args.includes("--yes");

  if (!skipConfirm) {
    clack.intro(bold("Purge old sessions"));
  }

  // Prompt for days if not provided
  if (days === undefined) {
    const answer = await clack.text({
      message: "Delete sessions older than how many days?",
      placeholder: "30",
      validate(v) {
        const n = Number(v);
        if (!v || !Number.isInteger(n) || n <= 0) return "Please enter a positive integer.";
      },
    });
    if (clack.isCancel(answer)) {
      clack.cancel("Cancelled.");
      return;
    }
    days = Number(answer);
  }

  const cutoff = Date.now() - days * DAY_MS;
  const candidates = withDb((db) => listSessions(db, { toDate: cutoff }));

  if (candidates.length === 0) {
    const msg = `No sessions older than ${days} day${days !== 1 ? "s" : ""} found.`;
    if (skipConfirm) {
      console.log(msg);
    } else {
      clack.log.info(msg);
      clack.outro("Nothing to purge.");
    }
    return;
  }

  const totalChunks = candidates.reduce((n, s) => n + s.chunk_count, 0);
  const summary = `${candidates.length} session${candidates.length !== 1 ? "s" : ""} (${totalChunks} chunks) older than ${days} day${days !== 1 ? "s" : ""}`;

  if (skipConfirm) {
    // Non-interactive: just do it
    const result = withDb((db) => deleteSessionsOlderThan(db, cutoff));
    console.log(`Deleted ${result.sessions} sessions (${result.chunks} chunks).`);
    return;
  }

  clack.log.warn(`Found ${summary}.`);

  const confirmed = await clack.confirm({
    message: `Permanently delete ${summary}?`,
    initialValue: false,
  });

  if (clack.isCancel(confirmed) || !confirmed) {
    clack.cancel("Purge cancelled — database was not modified.");
    return;
  }

  const result = withDb((db) => deleteSessionsOlderThan(db, cutoff));
  clack.log.success(`Deleted ${result.sessions} sessions (${result.chunks} chunks).`);
  clack.log.warn(
    "Note: sessions will be re-indexed on the next agent turn if source files still exist.",
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
  npx code-session-memory sessions                Browse sessions (tree: source → date → session)
  npx code-session-memory sessions list           Same as above (explicit sub-command)

  npx code-session-memory sessions print          Pick a session interactively, then print
  npx code-session-memory sessions print <id>     Print all chunks of a session directly

  npx code-session-memory sessions delete         Pick a session interactively, then delete
  npx code-session-memory sessions delete <id>    Delete a session directly

  npx code-session-memory sessions purge          Delete sessions older than N days (interactive)
  npx code-session-memory sessions purge --days <n>         Non-interactive, prompts for confirmation
  npx code-session-memory sessions purge --days <n> --yes   Fully non-interactive (no confirmation)

${b("Notes:")}
  - Deleting a session only removes it from the DB. If the source files still
    exist, the session will be re-indexed on the next agent turn.
  - "sessions print" output is pipe-friendly (no ANSI when stdout is not a TTY).
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function cmdSessions(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "list";

  if (argv.includes("--help") || argv.includes("-h")) {
    sessionsHelp();
    return;
  }

  switch (sub) {
    case "list":
      await cmdSessionsList();
      break;

    case "print": {
      const maybeId = argv[1] && !argv[1].startsWith("-") ? argv[1] : undefined;
      await cmdSessionsPrint(maybeId);
      break;
    }

    case "delete": {
      const maybeId = argv[1] && !argv[1].startsWith("-") ? argv[1] : undefined;
      await cmdSessionsDelete(maybeId);
      break;
    }

    case "purge":
      await cmdSessionsPurge(argv.slice(1));
      break;

    default:
      if (sub.startsWith("-")) {
        await cmdSessionsList();
      } else {
        console.error(`Unknown sessions sub-command: ${sub}`);
        console.error('Run "npx code-session-memory sessions --help" for usage.');
        process.exit(1);
      }
  }
}
