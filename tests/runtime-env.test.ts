/**
 * runtime-env.test.ts
 *
 * Covers the machinery that keeps hooks working under GUI-launched hosts
 * (the Claude desktop app started by launchd, a Windows/Linux desktop
 * launcher): those hosts give hooks no PATH to `node` and none of the
 * variables the user exports from their shell profile.
 *
 * - env snapshot: save/merge/load, 0600 permissions
 * - hydrateEnv: process.env wins, snapshot fills gaps, login-shell fallback
 * - node resolution and command quoting
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

import {
  getEnvFilePath,
  saveEnvSnapshot,
  loadEnvSnapshot,
  captureEnvFromProcess,
  hydrateEnv,
  probeLoginShellEnv,
  resolveNodeExecutable,
  isResolvedNodePath,
  buildNodeCommand,
  quoteForShell,
  maskEnvValue,
} from "../src/runtime-env";

// ---------------------------------------------------------------------------
// Isolation: every test gets its own HOME, so the real snapshot is untouched
// ---------------------------------------------------------------------------

let tempHome: string;
let originalHome: string | undefined;
const savedEnv: Record<string, string | undefined> = {};

const TOUCHED = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CSM_BACKEND", "SHELL"];

beforeEach(() => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "csm-runtime-env-"));
  process.env.HOME = tempHome;
  for (const key of TOUCHED) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const key of TOUCHED) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  fs.rmSync(tempHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Snapshot file
// ---------------------------------------------------------------------------

describe("env snapshot", () => {
  it("writes under the temp home and reads back", () => {
    saveEnvSnapshot({ OPENAI_API_KEY: "sk-test" });
    expect(getEnvFilePath().startsWith(tempHome)).toBe(true);
    expect(loadEnvSnapshot()).toEqual({ OPENAI_API_KEY: "sk-test" });
  });

  it("merges instead of clobbering, so a re-install never drops a variable", () => {
    saveEnvSnapshot({ OPENAI_API_KEY: "sk-old", CSM_BACKEND: "postgres" });
    saveEnvSnapshot({ OPENAI_API_KEY: "sk-new" });
    expect(loadEnvSnapshot()).toEqual({ OPENAI_API_KEY: "sk-new", CSM_BACKEND: "postgres" });
  });

  it("ignores empty values", () => {
    saveEnvSnapshot({ OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: "" });
    expect(loadEnvSnapshot()).toEqual({ OPENAI_API_KEY: "sk-test" });
  });

  it("stores the file 0600 — it holds an API key", () => {
    saveEnvSnapshot({ OPENAI_API_KEY: "sk-test" });
    const mode = fs.statSync(getEnvFilePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("tightens permissions on an existing world-readable snapshot", () => {
    saveEnvSnapshot({ OPENAI_API_KEY: "sk-test" });
    fs.chmodSync(getEnvFilePath(), 0o644);
    saveEnvSnapshot({ OPENAI_API_KEY: "sk-test-2" });
    expect(fs.statSync(getEnvFilePath()).mode & 0o777).toBe(0o600);
  });

  it("returns {} for a missing or corrupt file", () => {
    expect(loadEnvSnapshot()).toEqual({});
    fs.mkdirSync(path.dirname(getEnvFilePath()), { recursive: true });
    fs.writeFileSync(getEnvFilePath(), "not json");
    expect(loadEnvSnapshot()).toEqual({});
  });

  it("captures only the variables hooks need", () => {
    const captured = captureEnvFromProcess({
      OPENAI_API_KEY: "sk-test",
      CSM_POSTGRES_URL: "postgresql://u:p@h/db",
      HOME: "/should/not/be/captured",
      PATH: "/usr/bin",
    } as NodeJS.ProcessEnv);
    expect(captured).toEqual({
      OPENAI_API_KEY: "sk-test",
      CSM_POSTGRES_URL: "postgresql://u:p@h/db",
    });
  });
});

// ---------------------------------------------------------------------------
// hydrateEnv
// ---------------------------------------------------------------------------

describe("hydrateEnv", () => {
  it("fills gaps from the snapshot", () => {
    saveEnvSnapshot({ OPENAI_API_KEY: "sk-snapshot", OPENAI_BASE_URL: "http://localhost:1" });
    const result = hydrateEnv({ probeShell: false });

    expect(process.env.OPENAI_API_KEY).toBe("sk-snapshot");
    expect(process.env.OPENAI_BASE_URL).toBe("http://localhost:1");
    expect(result.fromSnapshot.sort()).toEqual(["OPENAI_API_KEY", "OPENAI_BASE_URL"]);
    expect(result.missing).toEqual([]);
  });

  it("never overrides a variable the host did provide", () => {
    process.env.OPENAI_API_KEY = "sk-from-host";
    saveEnvSnapshot({ OPENAI_API_KEY: "sk-snapshot" });

    const result = hydrateEnv({ probeShell: false });
    expect(process.env.OPENAI_API_KEY).toBe("sk-from-host");
    expect(result.fromSnapshot).toEqual([]);
  });

  it("reports what is still missing without probing", () => {
    const result = hydrateEnv({ probeShell: false });
    expect(result.missing).toEqual(["OPENAI_API_KEY"]);
    expect(result.fromShell).toEqual([]);
  });

  it("does not re-probe the login shell for hours after a failed probe", () => {
    const emptyShell = path.join(tempHome, "empty-shell");
    fs.writeFileSync(emptyShell, '#!/bin/sh\neval "$2"\n', { mode: 0o755 });
    process.env.SHELL = emptyShell;

    expect(hydrateEnv().missing).toEqual(["OPENAI_API_KEY"]);
    // The failure is recorded, so the next turn is not delayed by a probe.
    expect(loadEnvSnapshot()._lastProbeFailedAt).toBeTruthy();

    // A shell that would now answer is not consulted again.
    const goodShell = path.join(tempHome, "good-shell");
    fs.writeFileSync(
      goodShell,
      '#!/bin/sh\nOPENAI_API_KEY=sk-later\nexport OPENAI_API_KEY\neval "$2"\n',
      { mode: 0o755 },
    );
    process.env.SHELL = goodShell;
    expect(hydrateEnv().missing).toEqual(["OPENAI_API_KEY"]);

    // ...until a key is supplied explicitly, which clears the back-off.
    saveEnvSnapshot({ OPENAI_API_KEY: "sk-explicit" });
    expect(loadEnvSnapshot()._lastProbeFailedAt).toBeUndefined();
  });

  it("never exports snapshot bookkeeping keys as environment variables", () => {
    saveEnvSnapshot({ OPENAI_API_KEY: "sk-test", _lastProbeFailedAt: new Date().toISOString() });
    hydrateEnv({ probeShell: false });
    expect(process.env._lastProbeFailedAt).toBeUndefined();
  });

  it("falls back to the login shell and persists what it finds", () => {
    const fakeShell = path.join(tempHome, "fake-login-shell");
    fs.writeFileSync(
      fakeShell,
      '#!/bin/sh\nOPENAI_API_KEY=sk-from-profile\nexport OPENAI_API_KEY\neval "$2"\n',
      { mode: 0o755 },
    );
    process.env.SHELL = fakeShell;

    const result = hydrateEnv();

    expect(process.env.OPENAI_API_KEY).toBe("sk-from-profile");
    expect(result.fromShell).toEqual(["OPENAI_API_KEY"]);
    expect(result.missing).toEqual([]);
    // Persisted, so the next hook run does not spawn a shell again.
    expect(loadEnvSnapshot().OPENAI_API_KEY).toBe("sk-from-profile");
  });
});

// ---------------------------------------------------------------------------
// Login-shell probe
// ---------------------------------------------------------------------------

describe("probeLoginShellEnv", () => {
  it("returns {} when the shell exports nothing", () => {
    const fakeShell = path.join(tempHome, "empty-shell");
    fs.writeFileSync(fakeShell, '#!/bin/sh\neval "$2"\n', { mode: 0o755 });
    expect(probeLoginShellEnv(["OPENAI_API_KEY"], { shell: fakeShell })).toEqual({});
  });

  it("ignores noise a profile prints around the markers", () => {
    const fakeShell = path.join(tempHome, "noisy-shell");
    fs.writeFileSync(
      fakeShell,
      '#!/bin/sh\necho "welcome to your shell"\nOPENAI_API_KEY=sk-noisy\nexport OPENAI_API_KEY\neval "$2"\necho "bye"\n',
      { mode: 0o755 },
    );
    expect(probeLoginShellEnv(["OPENAI_API_KEY"], { shell: fakeShell })).toEqual({
      OPENAI_API_KEY: "sk-noisy",
    });
  });

  it("gives up on a shell that hangs instead of blocking the hook", () => {
    const fakeShell = path.join(tempHome, "hanging-shell");
    fs.writeFileSync(fakeShell, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
    const started = Date.now();
    expect(probeLoginShellEnv(["OPENAI_API_KEY"], { shell: fakeShell, timeoutMs: 500 })).toEqual({});
    // Two attempts (-lic then -lc), each bounded by the timeout.
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------
// Node resolution and command building
// ---------------------------------------------------------------------------

describe("node executable", () => {
  it("resolves to the absolute path of the running interpreter", () => {
    const resolved = resolveNodeExecutable();
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(isResolvedNodePath(resolved)).toBe(true);
  });

  it("treats a bare command or a vanished path as unresolved", () => {
    expect(isResolvedNodePath("node")).toBe(false);
    expect(isResolvedNodePath("/nonexistent/versions/node/v20.0.0/bin/node")).toBe(false);
  });

  it("quotes both paths so spaces survive", () => {
    const command = buildNodeCommand("/opt/my node/bin/node", "/Users/a b/indexer-cli-claude.js");
    expect(command).toBe('"/opt/my node/bin/node" "/Users/a b/indexer-cli-claude.js"');
  });

  it("refuses to build a command from a path containing a quote", () => {
    expect(() => quoteForShell('/tmp/we"ird')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

describe("maskEnvValue", () => {
  it("masks the API key but keeps it recognisable", () => {
    expect(maskEnvValue("OPENAI_API_KEY", "sk-abcdefghijkl")).toBe("sk-a…ijkl");
    expect(maskEnvValue("OPENAI_API_KEY", "short")).toBe("***");
  });

  it("masks the password inside a Postgres URL", () => {
    expect(maskEnvValue("CSM_POSTGRES_URL", "postgresql://csm:secret@host:5432/db"))
      .toBe("postgresql://csm:***@host:5432/db");
  });

  it("leaves non-secrets alone", () => {
    expect(maskEnvValue("OPENAI_MODEL", "text-embedding-3-large")).toBe("text-embedding-3-large");
  });
});
