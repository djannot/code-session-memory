/**
 * e2e-hook-bare-env.test.ts
 *
 * Reproduces the failure that made indexing silently stop in the Claude
 * desktop app: launchd (and the Windows/Linux equivalents) start GUI apps
 * with a bare environment — no shell profile, so `node` is not on PATH and
 * OPENAI_API_KEY is unset — and hooks inherit exactly that.
 *
 * The hook is spawned as a real subprocess with such an environment and must
 * still index the session, taking its API key and base URL from the snapshot
 * written at install time. A local HTTP stub stands in for the OpenAI
 * embeddings endpoint, so the test makes no network calls.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "child_process";
import http from "http";
import fs from "fs";
import os from "os";
import path from "path";

import { openDatabase, getSessionMeta, getSessionChunksOrdered } from "../src/database";

const REPO_ROOT = path.resolve(__dirname, "..");
const HOOK_ENTRY = path.join(REPO_ROOT, "src", "indexer-cli-claude.ts");
const TRANSCRIPT = path.join(__dirname, "fixtures", "claude-session.jsonl");
const EMBEDDING_DIM = 3072;

/** PATH a launchd-started GUI app gets on macOS — note: no /usr/local/bin. */
const BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

let tempHome: string;
let stub: http.Server;
let stubUrl: string;

/** Stands in for the OpenAI embeddings endpoint (base64 float32, as the SDK asks). */
function startEmbeddingStub(): Promise<void> {
  const vector = Buffer.from(new Float32Array(EMBEDDING_DIM).fill(0.01).buffer).toString("base64");
  stub = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let input: unknown = [];
      try { input = (JSON.parse(body) as { input: unknown }).input; } catch { /* ignore */ }
      const items = Array.isArray(input) ? input : [input];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        object: "list",
        model: "text-embedding-3-large",
        data: items.map((_, index) => ({ object: "embedding", index, embedding: vector })),
        usage: {},
      }));
    });
  });
  return new Promise((resolve) => {
    stub.listen(0, "127.0.0.1", () => {
      const address = stub.address() as { port: number };
      stubUrl = `http://127.0.0.1:${address.port}/v1`;
      resolve();
    });
  });
}

interface HookResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the hook as a real subprocess. Asynchronous on purpose: the embedding
 * stub is served by this process, so blocking here (spawnSync) would deadlock
 * the child's HTTP request.
 */
function runHookWithBareEnv(payload: object, extraEnv: NodeJS.ProcessEnv = {}): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    // Hooks are installed with an ABSOLUTE node path precisely because PATH
    // cannot be relied on — mirror that here.
    const child = spawn(process.execPath, ["--import", "tsx", HOOK_ENTRY], {
      cwd: REPO_ROOT,
      env: { HOME: tempHome, PATH: BARE_PATH, ...extraEnv },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Hook did not finish in time. stderr: ${stderr}`));
    }, 60_000);

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

function envFilePath(): string {
  return path.join(tempHome, ".config", "code-session-memory", "env.json");
}

function hookLogPath(): string {
  return path.join(tempHome, ".config", "code-session-memory", "logs", "hook.log");
}

function dbPath(): string {
  return path.join(tempHome, ".local", "share", "code-session-memory", "sessions.db");
}

beforeAll(async () => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "csm-bare-env-"));
  await startEmbeddingStub();
});

afterAll(async () => {
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  fs.rmSync(tempHome, { recursive: true, force: true });
});

describe("Claude Code Stop hook under a GUI-launched (bare) environment", () => {
  it("logs a clear error instead of failing silently when nothing supplies the key", async () => {
    // SHELL points at a shell whose profile exports nothing, so the
    // login-shell fallback comes up empty too.
    const result = await runHookWithBareEnv(
      { session_id: "no-key-session", transcript_path: TRANSCRIPT, cwd: "/test/project" },
      { SHELL: "/usr/bin/false" },
    );

    // The hook must not take the host down with it.
    expect(result.status).toBe(0);

    const log = fs.readFileSync(hookLogPath(), "utf8");
    expect(log).toContain("OPENAI_API_KEY");
    expect(log).toContain("[error]");
  });

  it("indexes the session using the env snapshot when the host provides no environment", async () => {
    fs.mkdirSync(path.dirname(envFilePath()), { recursive: true });
    fs.writeFileSync(
      envFilePath(),
      JSON.stringify({ OPENAI_API_KEY: "sk-test-key", OPENAI_BASE_URL: stubUrl }),
      { mode: 0o600 },
    );

    const result = await runHookWithBareEnv({
      session_id: "bare-env-session",
      transcript_path: TRANSCRIPT,
      cwd: "/test/project",
    });

    expect(result.status).toBe(0);

    // The session really landed in the database.
    const db = openDatabase({ dbPath: dbPath() });
    try {
      expect(getSessionMeta(db, "bare-env-session")).toBeTruthy();
      expect(getSessionChunksOrdered(db, "bare-env-session").length).toBeGreaterThan(0);
    } finally {
      db.close();
    }

    // ...and the run is visible in the hook log.
    const log = fs.readFileSync(hookLogPath(), "utf8");
    expect(log).toMatch(/\[info\] \[claude-code\] session bare-env-session: \d+ chunk\(s\) indexed/);
  });

  it("recovers the key from the login shell when the snapshot lacks it", async () => {
    const fakeShell = path.join(tempHome, "fake-login-shell");
    fs.writeFileSync(
      fakeShell,
      `#!/bin/sh\nOPENAI_API_KEY=sk-from-profile\nexport OPENAI_API_KEY\neval "$2"\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(envFilePath(), JSON.stringify({ OPENAI_BASE_URL: stubUrl }), { mode: 0o600 });

    const result = await runHookWithBareEnv({
      session_id: "shell-probe-session",
      transcript_path: TRANSCRIPT,
      cwd: "/test/project",
    }, { SHELL: fakeShell });

    expect(result.status).toBe(0);

    // The probe result is persisted, so later runs cost no shell spawn.
    const snapshot = JSON.parse(fs.readFileSync(envFilePath(), "utf8")) as Record<string, string>;
    expect(snapshot.OPENAI_API_KEY).toBe("sk-from-profile");

    const db = openDatabase({ dbPath: dbPath() });
    try {
      expect(getSessionMeta(db, "shell-probe-session")).toBeTruthy();
    } finally {
      db.close();
    }
  });
});
