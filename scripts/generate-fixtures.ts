#!/usr/bin/env tsx
/**
 * generate-fixtures.ts
 *
 * Generates committed test fixture files by running real Claude Code and OpenCode
 * CLI sessions. Run manually on demand:
 *
 *   npm run generate-fixtures
 *
 * Fixtures are written to tests/fixtures/ and should be committed to git.
 * The sessions are isolated to a throw-away DB via OPENCODE_MEMORY_DB_PATH.
 *
 * Requirements:
 *   - `claude` CLI available in PATH (Claude Code)
 *   - `opencode` CLI available in PATH
 *   - Cursor state.vscdb must exist (for Cursor fixtures)
 */

import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(__dirname, "..", "tests", "fixtures");
const TEMP_DB = path.join(os.tmpdir(), `fixture-gen-${Date.now()}.db`);
const CWD = path.join(__dirname, "..");  // project root

// Encoding used by Claude Code to map project paths to directory names
function encodeProjectPath(p: string): string {
  return p.replace(/\//g, "-");
}

function claudeProjectDir(): string {
  const encoded = encodeProjectPath(CWD);
  return path.join(os.homedir(), ".claude", "projects", encoded);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function run(cmd: string, env: NodeJS.ProcessEnv = {}): string {
  console.log(`  $ ${cmd}`);
  const result = spawnSync(cmd, {
    shell: true,
    cwd: CWD,
    env: { ...process.env, ...env },
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const stderr = result.stderr?.toString() ?? "";
  const stdout = result.stdout?.toString() ?? "";
  if (result.status !== 0) {
    console.error("  STDERR:", stderr.slice(0, 2000));
    throw new Error(`Command failed (exit ${result.status}): ${cmd}`);
  }
  if (stderr) console.error("  stderr:", stderr.slice(0, 500));
  return stdout;
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
  console.log(`  wrote ${path.relative(CWD, filePath)}`);
}

function writeText(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
  console.log(`  wrote ${path.relative(CWD, filePath)}`);
}

// ---------------------------------------------------------------------------
// Claude Code fixtures
// ---------------------------------------------------------------------------

async function generateClaudeFixtures(): Promise<string> {
  console.log("\n=== Claude Code fixtures ===");

  // Turn 1: ask Claude to list files using bash
  console.log("\n[Turn 1] Running claude -p ...");
  const turn1Raw = run(
    `claude -p "List files in the current directory using the Bash tool. Just run: ls -1" --output-format json --allowedTools "Bash"`,
    { OPENCODE_MEMORY_DB_PATH: TEMP_DB },
  );

  let turn1Result: { session_id: string };
  try {
    turn1Result = JSON.parse(turn1Raw);
  } catch {
    throw new Error(`Failed to parse claude turn1 JSON: ${turn1Raw.slice(0, 500)}`);
  }

  const sessionId = turn1Result.session_id;
  console.log(`  session_id: ${sessionId}`);

  // Locate the JSONL transcript
  const projectDir = claudeProjectDir();
  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);

  if (!fs.existsSync(jsonlPath)) {
    throw new Error(`JSONL not found at: ${jsonlPath}`);
  }

  // Snapshot turn 1 — all lines up to but NOT including the final
  // summary/system entry (last non-blank line is typically a system summary).
  // We just copy everything that exists after turn 1 before turn 2 happens.
  const turn1Lines = fs.readFileSync(jsonlPath, "utf8")
    .split("\n")
    .filter((l) => l.trim());

  writeText(path.join(FIXTURES_DIR, "claude-turn1.jsonl"), turn1Lines.join("\n") + "\n");

  // Turn 2: follow-up question
  console.log("\n[Turn 2] Running claude -p ... --resume ...");
  run(
    `claude -p "How many files did you list? Just give me a number." --output-format json --resume ${sessionId} --allowedTools "Bash"`,
    { OPENCODE_MEMORY_DB_PATH: TEMP_DB },
  );

  // Full session transcript (both turns)
  const fullLines = fs.readFileSync(jsonlPath, "utf8")
    .split("\n")
    .filter((l) => l.trim());

  writeText(path.join(FIXTURES_DIR, "claude-session.jsonl"), fullLines.join("\n") + "\n");
  console.log(`  turn1: ${turn1Lines.length} lines, full: ${fullLines.length} lines`);

  return sessionId;
}

// ---------------------------------------------------------------------------
// OpenCode fixtures
// ---------------------------------------------------------------------------

async function generateOpenCodeFixtures(): Promise<string> {
  console.log("\n=== OpenCode fixtures ===");

  // Turn 1: ask OpenCode to list files using the Glob tool
  console.log("\n[Turn 1] Running opencode run ...");
  const turn1Raw = run(
    `opencode run --format json "List TypeScript files in the src directory using the Glob tool. Use pattern src/**/*.ts"`,
    { OPENCODE_MEMORY_DB_PATH: TEMP_DB },
  );

  // Parse sessionID from streamed JSON events (one JSON object per line)
  let sessionId = "";
  for (const line of turn1Raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt.sessionID) {
        sessionId = evt.sessionID;
        break;
      }
    } catch {
      // non-JSON line — skip
    }
  }

  if (!sessionId) {
    throw new Error(`Could not extract sessionID from opencode output:\n${turn1Raw.slice(0, 1000)}`);
  }
  console.log(`  sessionID: ${sessionId}`);

  // Export turn 1 snapshot (first 2 messages: user prompt + assistant reply)
  const exportRaw1 = run(`opencode export ${sessionId}`);
  const exportData1 = JSON.parse(exportRaw1) as {
    info: { id: string; title?: string; directory?: string };
    messages: unknown[];
  };

  const turn1Export = {
    info: exportData1.info,
    messages: exportData1.messages.slice(0, 2),
  };
  writeJson(path.join(FIXTURES_DIR, "opencode-turn1.json"), turn1Export);

  // Turn 2: follow-up
  console.log("\n[Turn 2] Running opencode run --session ...");
  run(
    `opencode run --format json --session ${sessionId} "How many TypeScript files are in the src directory?"`,
    { OPENCODE_MEMORY_DB_PATH: TEMP_DB },
  );

  // Export full session (both turns)
  const exportRaw2 = run(`opencode export ${sessionId}`);
  const exportData2 = JSON.parse(exportRaw2) as {
    info: { id: string; title?: string; directory?: string };
    messages: unknown[];
  };
  writeJson(path.join(FIXTURES_DIR, "opencode-session.json"), exportData2);
  console.log(`  turn1: ${turn1Export.messages.length} messages, full: ${exportData2.messages.length} messages`);

  return sessionId;
}

// ---------------------------------------------------------------------------
// Cursor fixtures
// ---------------------------------------------------------------------------

/**
 * Reads the Cursor state.vscdb and snapshots a known composer session as JSON.
 *
 * Because Cursor has no CLI that programmatically runs a session, we rely on
 * a real session that already exists in the user's Cursor DB. The composerId
 * is looked up from the manifest if present (cursor_composer_id), or we pick
 * the most-recently-updated composer.
 */
async function generateCursorFixtures(
  existingComposerId?: string,
): Promise<{ composerId: string }> {
  console.log("\n=== Cursor fixtures ===");

  // Dynamically import cursor-to-messages so tsx can handle it without a build step
  const cursorModule = await import("../src/cursor-to-messages");
  const {
    resolveCursorDbPath,
    openCursorDb,
    listComposerIds,
    getComposerData,
    cursorSessionToMessages,
  } = cursorModule;

  const dbPath = resolveCursorDbPath();
  console.log(`  Cursor DB: ${dbPath}`);

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Cursor state.vscdb not found at: ${dbPath}`);
  }

  const db = openCursorDb(dbPath);

  let composerId: string;

  try {
    if (existingComposerId) {
      // Verify it still exists
      const composer = getComposerData(db, existingComposerId);
      if (composer) {
        composerId = existingComposerId;
        console.log(`  Using existing composerId: ${composerId}`);
      } else {
        console.warn(`  Existing composerId not found: ${existingComposerId}, picking most recent`);
        const ids = listComposerIds(db);
        if (ids.length === 0) throw new Error("No Cursor sessions found in state.vscdb");
        composerId = ids[0];
      }
    } else {
      // Pick the most recently-updated session with at least one user message
      const ids = listComposerIds(db);
      if (ids.length === 0) throw new Error("No Cursor sessions found in state.vscdb");
      composerId = ids[0];
    }

    console.log(`  composerId: ${composerId}`);

    const composer = getComposerData(db, composerId);
    if (!composer) throw new Error(`composerData not found for: ${composerId}`);

    const messages = cursorSessionToMessages(db, composerId);
    console.log(`  messages: ${messages.length}`);

    if (messages.length === 0) {
      throw new Error("Selected Cursor session has no messages — pick a different session");
    }

    // Full session fixture
    const sessionFixture = {
      composerId,
      name: composer.name ?? "",
      messages,
    };
    writeJson(path.join(FIXTURES_DIR, "cursor-session.json"), sessionFixture);

    // Turn-1 fixture: just the first user + next AI message(s) up to (but not
    // including) the second user message
    let turn1End = messages.length;
    let userCount = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].info.role === "user") {
        userCount++;
        if (userCount === 2) {
          turn1End = i;
          break;
        }
      }
    }
    const turn1Fixture = {
      composerId,
      name: composer.name ?? "",
      messages: messages.slice(0, turn1End),
    };
    writeJson(path.join(FIXTURES_DIR, "cursor-turn1.json"), turn1Fixture);

    console.log(`  turn1: ${turn1Fixture.messages.length} messages, full: ${messages.length} messages`);
  } finally {
    db.close();
  }

  return { composerId };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("Generating test fixtures...");
  console.log(`  fixtures dir : ${FIXTURES_DIR}`);
  console.log(`  temp DB      : ${TEMP_DB}`);
  console.log(`  project root : ${CWD}`);

  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  // Read existing manifest to reuse IDs where possible
  const manifestPath = path.join(FIXTURES_DIR, "manifest.json");
  let existingManifest: Record<string, string> = {};
  if (fs.existsSync(manifestPath)) {
    try {
      existingManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch { /* ignore */ }
  }

  let claudeSessionId = "";
  let openCodeSessionId = "";
  let cursorComposerId = "";

  try {
    claudeSessionId = await generateClaudeFixtures();
  } catch (err) {
    console.error("\nFailed to generate Claude fixtures:", err);
    process.exit(1);
  }

  try {
    openCodeSessionId = await generateOpenCodeFixtures();
  } catch (err) {
    console.error("\nFailed to generate OpenCode fixtures:", err);
    process.exit(1);
  }

  try {
    const result = await generateCursorFixtures(existingManifest.cursor_composer_id);
    cursorComposerId = result.composerId;
  } catch (err) {
    console.error("\nFailed to generate Cursor fixtures:", err);
    process.exit(1);
  }

  // Write manifest
  const manifest = {
    generated_at: new Date().toISOString(),
    claude_session_id: claudeSessionId,
    claude_project_dir: claudeProjectDir(),
    opencode_session_id: openCodeSessionId,
    cursor_composer_id: cursorComposerId,
  };
  writeJson(path.join(FIXTURES_DIR, "manifest.json"), manifest);

  // Clean up temp DB
  try {
    fs.rmSync(TEMP_DB, { force: true });
    for (const ext of ["-shm", "-wal"]) {
      fs.rmSync(TEMP_DB + ext, { force: true });
    }
  } catch {
    // ignore cleanup errors
  }

  console.log("\nDone. Commit the files in tests/fixtures/ to git.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
