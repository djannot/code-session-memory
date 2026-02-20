#!/usr/bin/env node
/**
 * code-session-memory CLI
 *
 * Usage:
 *   npx code-session-memory install        — install for OpenCode + Claude Code
 *   npx code-session-memory status         — show installation status
 *   npx code-session-memory uninstall      — remove all installed components
 *   npx code-session-memory reset-db       — wipe the database (with confirmation)
 *   npx code-session-memory sessions       — browse / print / delete sessions
 */

import fs from "fs";
import path from "path";
import os from "os";
import { resolveDbPath, openDatabase } from "./database";
import { cmdSessions } from "./cli-sessions";

// ---------------------------------------------------------------------------
// Paths — OpenCode
// ---------------------------------------------------------------------------

function getOpenCodeConfigDir(): string {
  const envDir = process.env.OPENCODE_CONFIG_DIR;
  if (envDir) return envDir;
  return path.join(os.homedir(), ".config", "opencode");
}

function getOpenCodePluginDst(): string {
  return path.join(getOpenCodeConfigDir(), "plugins", "code-session-memory.ts");
}

function getOpenCodeSkillDst(): string {
  return path.join(getOpenCodeConfigDir(), "skills", "code-session-memory.md");
}

function getGlobalOpenCodeConfigPath(): string {
  return path.join(getOpenCodeConfigDir(), "opencode.json");
}

// ---------------------------------------------------------------------------
// Paths — Claude Code
// ---------------------------------------------------------------------------

function getClaudeConfigDir(): string {
  const envDir = process.env.CLAUDE_CONFIG_DIR;
  if (envDir) return envDir;
  return path.join(os.homedir(), ".claude");
}

function getClaudeSettingsPath(): string {
  return path.join(getClaudeConfigDir(), "settings.json");
}

/**
 * ~/.claude.json — user-scoped config file where Claude Code stores global
 * MCP servers (written by `claude mcp add --scope user`).
 */
function getClaudeUserConfigPath(): string {
  // ~/.claude.json lives next to the ~/.claude/ directory
  return path.join(path.dirname(getClaudeConfigDir()), ".claude.json");
}

function getClaudeMdPath(): string {
  return path.join(getClaudeConfigDir(), "CLAUDE.md");
}

// ---------------------------------------------------------------------------
// Paths — package
// ---------------------------------------------------------------------------

function getPackageRoot(): string {
  // __dirname is dist/src/ after build, so go two levels up
  return path.resolve(__dirname, "..", "..");
}

function getPluginSrc(): string {
  return path.join(getPackageRoot(), "plugin", "memory.ts");
}

function getSkillSrc(): string {
  return path.join(getPackageRoot(), "skill", "memory.md");
}

function getMcpServerPath(): string {
  return path.join(getPackageRoot(), "dist", "mcp", "index.js");
}

function getIndexerCliPath(): string {
  return path.join(getPackageRoot(), "dist", "src", "indexer-cli.js");
}

function getIndexerCliClaudePath(): string {
  return path.join(getPackageRoot(), "dist", "src", "indexer-cli-claude.js");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src: string, dst: string): void {
  if (!fs.existsSync(src)) {
    throw new Error(`Source file not found: ${src}\nDid you run "npm run build" first?`);
  }
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

/**
 * Copies the OpenCode plugin template, replacing the OPENCODE_MEMORY_INDEXER_PATH
 * placeholder with the absolute path to indexer-cli.js.
 */
function installOpenCodePlugin(src: string, dst: string): void {
  if (!fs.existsSync(src)) {
    throw new Error(`Plugin source not found: ${src}\nDid you run "npm run build" first?`);
  }
  let content = fs.readFileSync(src, "utf8");
  content = content.replace(
    '"OPENCODE_MEMORY_INDEXER_PATH"',
    JSON.stringify(getIndexerCliPath()),
  );
  ensureDir(path.dirname(dst));
  fs.writeFileSync(dst, content, "utf8");
}

/**
 * Merges the code-session-memory MCP entry into the global opencode.json.
 */
function installOpenCodeMcpConfig(mcpServerPath: string): { configPath: string; existed: boolean } {
  const configPath = getGlobalOpenCodeConfigPath();
  const existed = fs.existsSync(configPath);

  let config: Record<string, unknown> = { $schema: "https://opencode.ai/config.json" };
  if (existed) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      throw new Error(`Could not parse existing ${configPath} — please check it is valid JSON.`);
    }
  }

  if (!config.mcp || typeof config.mcp !== "object") config.mcp = {};
  (config.mcp as Record<string, unknown>)["code-session-memory"] = {
    type: "local",
    command: ["node", mcpServerPath],
  };

  ensureDir(path.dirname(configPath));
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { configPath, existed };
}

/**
 * Removes the code-session-memory MCP entry from opencode.json.
 */
function uninstallOpenCodeMcpConfig(): "done" | "not_found" {
  const configPath = getGlobalOpenCodeConfigPath();
  if (!fs.existsSync(configPath)) return "not_found";
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    if (cfg.mcp && typeof cfg.mcp === "object" && "code-session-memory" in (cfg.mcp as object)) {
      delete (cfg.mcp as Record<string, unknown>)["code-session-memory"];
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      return "done";
    }
    return "not_found";
  } catch {
    return "not_found";
  }
}

/**
 * Installs/updates the Claude Code Stop hook in ~/.claude/settings.json.
 */
function installClaudeHook(indexerCliClaudePath: string): { settingsPath: string; existed: boolean } {
  const settingsPath = getClaudeSettingsPath();
  const existed = fs.existsSync(settingsPath);

  let settings: Record<string, unknown> = {};
  if (existed) {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch {
      throw new Error(`Could not parse existing ${settingsPath} — please check it is valid JSON.`);
    }
  }

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};
  const hooks = settings.hooks as Record<string, unknown[]>;

  // Remove any existing code-session-memory Stop hook
  if (Array.isArray(hooks.Stop)) {
    hooks.Stop = hooks.Stop.filter((group: unknown) => {
      if (!group || typeof group !== "object") return true;
      const g = group as Record<string, unknown>;
      if (!Array.isArray(g.hooks)) return true;
      return !g.hooks.some((h: unknown) => {
        const handler = h as Record<string, unknown>;
        return typeof handler.command === "string" &&
          handler.command.includes("indexer-cli-claude");
      });
    });
  } else {
    hooks.Stop = [];
  }

  // Add our hook (synchronous — must NOT be async so the JSONL is fully
  // written by Claude Code before we read it)
  hooks.Stop.push({
    hooks: [
      {
        type: "command",
        command: `node ${indexerCliClaudePath}`,
      },
    ],
  });

  ensureDir(path.dirname(settingsPath));
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return { settingsPath, existed };
}

/**
 * Removes the code-session-memory Stop hook from ~/.claude/settings.json.
 */
function uninstallClaudeHook(): "done" | "not_found" {
  const settingsPath = getClaudeSettingsPath();
  if (!fs.existsSync(settingsPath)) return "not_found";
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const hooks = settings.hooks as Record<string, unknown[]> | undefined;
    if (!hooks || !Array.isArray(hooks.Stop)) return "not_found";

    const before = hooks.Stop.length;
    hooks.Stop = hooks.Stop.filter((group: unknown) => {
      if (!group || typeof group !== "object") return true;
      const g = group as Record<string, unknown>;
      if (!Array.isArray(g.hooks)) return true;
      return !g.hooks.some((h: unknown) => {
        const handler = h as Record<string, unknown>;
        return typeof handler.command === "string" &&
          handler.command.includes("indexer-cli-claude");
      });
    });

    if (hooks.Stop.length === before) return "not_found";
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    return "done";
  } catch {
    return "not_found";
  }
}

/**
 * Appends the memory skill context to ~/.claude/CLAUDE.md.
 */
function installClaudeMd(skillSrc: string): { mdPath: string; existed: boolean } {
  const mdPath = getClaudeMdPath();
  const existed = fs.existsSync(mdPath);
  const marker = "<!-- code-session-memory -->";

  const skillContent = fs.existsSync(skillSrc)
    ? fs.readFileSync(skillSrc, "utf8")
    : "";

  if (existed) {
    const current = fs.readFileSync(mdPath, "utf8");
    // Replace existing block if present
    if (current.includes(marker)) {
      const updated = current.replace(
        new RegExp(`${marker}[\\s\\S]*?${marker}`, "g"),
        `${marker}\n${skillContent}\n${marker}`,
      );
      fs.writeFileSync(mdPath, updated, "utf8");
      return { mdPath, existed };
    }
    // Append
    fs.writeFileSync(mdPath, current + `\n\n${marker}\n${skillContent}\n${marker}\n`, "utf8");
  } else {
    ensureDir(path.dirname(mdPath));
    fs.writeFileSync(mdPath, `${marker}\n${skillContent}\n${marker}\n`, "utf8");
  }
  return { mdPath, existed };
}

/**
 * Removes the code-session-memory block from CLAUDE.md.
 */
function uninstallClaudeMd(): "done" | "not_found" {
  const mdPath = getClaudeMdPath();
  if (!fs.existsSync(mdPath)) return "not_found";
  const marker = "<!-- code-session-memory -->";
  const content = fs.readFileSync(mdPath, "utf8");
  if (!content.includes(marker)) return "not_found";
  const updated = content
    .replace(new RegExp(`\\n?\\n?${marker}[\\s\\S]*?${marker}\\n?`, "g"), "")
    .trimEnd();
  fs.writeFileSync(mdPath, updated ? updated + "\n" : "", "utf8");
  return "done";
}

function checkMcpConfigured(): boolean {
  const configPath = getGlobalOpenCodeConfigPath();
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    return !!(cfg.mcp && typeof cfg.mcp === "object" && "code-session-memory" in (cfg.mcp as object));
  } catch { return false; }
}

/**
 * Merges the code-session-memory MCP entry into ~/.claude.json (user-scoped).
 * Claude Code stores global MCP servers here under "mcpServers" with
 * { type: "stdio", command, args, env } shape.
 */
function installClaudeMcpConfig(mcpServerPath: string): { configPath: string; existed: boolean } {
  const configPath = getClaudeUserConfigPath();
  const existed = fs.existsSync(configPath);

  let config: Record<string, unknown> = {};
  if (existed) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      throw new Error(`Could not parse existing ${configPath} — please check it is valid JSON.`);
    }
  }

  if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
  (config.mcpServers as Record<string, unknown>)["code-session-memory"] = {
    type: "stdio",
    command: "node",
    args: [mcpServerPath],
    env: {},
  };

  ensureDir(path.dirname(configPath));
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { configPath, existed };
}

/**
 * Removes the code-session-memory MCP entry from ~/.claude.json.
 */
function uninstallClaudeMcpConfig(): "done" | "not_found" {
  const configPath = getClaudeUserConfigPath();
  if (!fs.existsSync(configPath)) return "not_found";
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    if (
      config.mcpServers &&
      typeof config.mcpServers === "object" &&
      "code-session-memory" in (config.mcpServers as object)
    ) {
      delete (config.mcpServers as Record<string, unknown>)["code-session-memory"];
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
      return "done";
    }
    return "not_found";
  } catch {
    return "not_found";
  }
}

function checkClaudeMcpConfigured(): boolean {
  const configPath = getClaudeUserConfigPath();
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    return !!(
      config.mcpServers &&
      typeof config.mcpServers === "object" &&
      "code-session-memory" in (config.mcpServers as object)
    );
  } catch { return false; }
}

function checkClaudeHookInstalled(): boolean {
  const settingsPath = getClaudeSettingsPath();
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const hooks = settings.hooks as Record<string, unknown[]> | undefined;
    if (!hooks || !Array.isArray(hooks.Stop)) return false;
    return hooks.Stop.some((group: unknown) => {
      if (!group || typeof group !== "object") return false;
      const g = group as Record<string, unknown>;
      if (!Array.isArray(g.hooks)) return false;
      return g.hooks.some((h: unknown) => {
        const handler = h as Record<string, unknown>;
        return typeof handler.command === "string" &&
          handler.command.includes("indexer-cli-claude");
      });
    });
  } catch { return false; }
}

function checkClaudeMdInstalled(): boolean {
  const mdPath = getClaudeMdPath();
  if (!fs.existsSync(mdPath)) return false;
  return fs.readFileSync(mdPath, "utf8").includes("<!-- code-session-memory -->");
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function bold(s: string): string { return `\x1b[1m${s}\x1b[0m`; }
function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function red(s: string): string { return `\x1b[31m${s}\x1b[0m`; }
function dim(s: string): string { return `\x1b[2m${s}\x1b[0m`; }
function ok(v: boolean): string { return v ? green("✓") : red("✗"); }

function step(label: string, fn: () => string): void {
  process.stdout.write(`  ${label}... `);
  try {
    const result = fn();
    console.log(green("done") + (result ? dim(` (${result})`) : ""));
  } catch (err: unknown) {
    console.log(red("failed"));
    console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function install(): void {
  console.log(bold("\ncode-session-memory install\n"));

  const dbPath = resolveDbPath();
  const mcpPath = getMcpServerPath();
  const indexerClaudePath = getIndexerCliClaudePath();

  // 1. DB
  step("Initialising database", () => {
    ensureDir(path.dirname(dbPath));
    const db = openDatabase({ dbPath });
    db.close();
    return dbPath;
  });

  // 2. OpenCode plugin
  step("Installing OpenCode plugin", () => {
    const dst = getOpenCodePluginDst();
    installOpenCodePlugin(getPluginSrc(), dst);
    return dst;
  });

  // 3. OpenCode skill
  step("Installing OpenCode skill", () => {
    const dst = getOpenCodeSkillDst();
    copyFile(getSkillSrc(), dst);
    return dst;
  });

  // 4. OpenCode MCP config
  step("Configuring OpenCode MCP server", () => {
    const { configPath, existed } = installOpenCodeMcpConfig(mcpPath);
    return `${existed ? "updated" : "created"} ${configPath}`;
  });

  // 5. Claude Code MCP config
  step("Configuring Claude Code MCP server", () => {
    const { configPath, existed } = installClaudeMcpConfig(mcpPath);
    return `${existed ? "updated" : "created"} ${configPath}`;
  });

  // 6. Claude Code hook
  step("Installing Claude Code Stop hook", () => {
    const { settingsPath, existed } = installClaudeHook(indexerClaudePath);
    return `${existed ? "updated" : "created"} ${settingsPath}`;
  });

  // 7. Claude Code CLAUDE.md
  step("Installing Claude Code context (CLAUDE.md)", () => {
    const { mdPath, existed } = installClaudeMd(getSkillSrc());
    return `${existed ? "updated" : "created"} ${mdPath}`;
  });

  console.log(`
${bold("Installation complete!")}

${bold("Required environment variable:")}
  OPENAI_API_KEY  — for embedding generation

${bold("Default DB path:")} ${dbPath}

Restart ${bold("OpenCode")} and ${bold("Claude Code")} to activate.
Run ${bold("npx code-session-memory status")} to verify.
`);
}

function status(): void {
  console.log(bold("\ncode-session-memory status\n"));

  const dbPath = resolveDbPath();
  const mcpPath = getMcpServerPath();

  console.log(bold("  OpenCode"));
  console.log(`  ${ok(fs.existsSync(getOpenCodePluginDst()))}  Plugin      ${dim(getOpenCodePluginDst())}`);
  console.log(`  ${ok(fs.existsSync(getOpenCodeSkillDst()))}  Skill       ${dim(getOpenCodeSkillDst())}`);
  console.log(`  ${ok(checkMcpConfigured())}  MCP config  ${dim(getGlobalOpenCodeConfigPath())}`);

  console.log(bold("\n  Claude Code"));
  console.log(`  ${ok(checkClaudeMcpConfigured())}  MCP config  ${dim(getClaudeUserConfigPath())}`);
  console.log(`  ${ok(checkClaudeHookInstalled())}  Stop hook   ${dim(getClaudeSettingsPath())}`);
  console.log(`  ${ok(checkClaudeMdInstalled())}  CLAUDE.md   ${dim(getClaudeMdPath())}`);

  console.log(bold("\n  Shared"));
  console.log(`  ${ok(fs.existsSync(mcpPath))}  MCP server  ${dim(mcpPath)}`);
  console.log(`  ${ok(fs.existsSync(dbPath))}  Database    ${dim(dbPath)}`);

  if (fs.existsSync(dbPath)) {
    try {
      const db = openDatabase({ dbPath });
      const chunks = (db.prepare("SELECT COUNT(*) as n FROM vec_items").get() as { n: number }).n;
      const sessions = (db.prepare("SELECT COUNT(*) as n FROM sessions_meta").get() as { n: number }).n;
      const bySource = db.prepare(
        "SELECT source, COUNT(*) as n FROM sessions_meta GROUP BY source"
      ).all() as Array<{ source: string; n: number }>;
      db.close();
      console.log(`\n  ${dim("Indexed chunks:   ")}${chunks}`);
      console.log(`  ${dim("Sessions tracked: ")}${sessions}`);
      for (const row of bySource) {
        console.log(`    ${dim(`${row.source}:`)} ${row.n}`);
      }
    } catch { /* DB might be empty */ }
  }

  const allOk = fs.existsSync(getOpenCodePluginDst()) &&
    fs.existsSync(getOpenCodeSkillDst()) &&
    checkMcpConfigured() &&
    checkClaudeMcpConfigured() &&
    checkClaudeHookInstalled() &&
    checkClaudeMdInstalled() &&
    fs.existsSync(mcpPath) &&
    fs.existsSync(dbPath);

  console.log(`\n  ${allOk
    ? green("All components installed.")
    : red("Some components missing — run \"npx code-session-memory install\".")
  }\n`);
}

function uninstall(): void {
  console.log(bold("\ncode-session-memory uninstall\n"));

  const items: Array<[string, () => void]> = [
    ["OpenCode plugin", () => {
      const p = getOpenCodePluginDst();
      if (fs.existsSync(p)) fs.unlinkSync(p);
      else throw new Error("not found");
    }],
    ["OpenCode skill", () => {
      const p = getOpenCodeSkillDst();
      if (fs.existsSync(p)) fs.unlinkSync(p);
      else throw new Error("not found");
    }],
    ["OpenCode MCP config", () => {
      if (uninstallOpenCodeMcpConfig() === "not_found") throw new Error("not found");
    }],
    ["Claude Code MCP config", () => {
      if (uninstallClaudeMcpConfig() === "not_found") throw new Error("not found");
    }],
    ["Claude Code hook", () => {
      if (uninstallClaudeHook() === "not_found") throw new Error("not found");
    }],
    ["Claude Code CLAUDE.md", () => {
      if (uninstallClaudeMd() === "not_found") throw new Error("not found");
    }],
  ];

  for (const [label, fn] of items) {
    process.stdout.write(`  Removing ${label}... `);
    try {
      fn();
      console.log(green("done"));
    } catch {
      console.log(dim("not found"));
    }
  }

  console.log(`
  ${dim("Note: the database was NOT removed.")}
  ${dim(`To delete it: rm "${resolveDbPath()}"`)}
`);
}

function resetDb(): void {
  console.log(bold("\ncode-session-memory reset-db\n"));

  const dbPath = resolveDbPath();

  if (!fs.existsSync(dbPath)) {
    console.log(`  ${dim("Database not found:")} ${dbPath}`);
    console.log(`  Nothing to reset.\n`);
    return;
  }

  // Show current stats before asking
  try {
    const db = openDatabase({ dbPath });
    const chunks = (db.prepare("SELECT COUNT(*) as n FROM vec_items").get() as { n: number }).n;
    const sessions = (db.prepare("SELECT COUNT(*) as n FROM sessions_meta").get() as { n: number }).n;
    db.close();
    console.log(`  Database: ${dim(dbPath)}`);
    console.log(`  Indexed chunks:   ${chunks}`);
    console.log(`  Sessions tracked: ${sessions}\n`);
  } catch {
    console.log(`  Database: ${dim(dbPath)}\n`);
  }

  // Prompt for confirmation
  process.stdout.write(`  ${red("This will permanently delete all indexed data.")} Confirm? [y/N] `);

  const response = (() => {
    try {
      // Read a single line synchronously from stdin
      const buf = Buffer.alloc(64);
      const n = fs.readSync(0, buf, 0, buf.length, null);
      return buf.slice(0, n).toString("utf8").trim().toLowerCase();
    } catch {
      return "";
    }
  })();

  if (response !== "y" && response !== "yes") {
    console.log(`\n  ${dim("Aborted — database was not modified.")}\n`);
    return;
  }

  fs.unlinkSync(dbPath);

  // Re-initialise an empty DB
  const db = openDatabase({ dbPath });
  db.close();

  console.log(`\n  ${green("Done.")} Database reset — all indexed data removed.\n`);
}

function help(): void {
  console.log(`
${bold("code-session-memory")} — Shared vector memory for OpenCode and Claude Code sessions

${bold("Usage:")}
  npx code-session-memory install              Install all components (OpenCode + Claude Code)
  npx code-session-memory status               Show installation status and DB stats
  npx code-session-memory uninstall            Remove all installed components (keeps DB)
  npx code-session-memory reset-db             Delete all indexed data (keeps installation)
  npx code-session-memory sessions             Browse sessions interactively
  npx code-session-memory sessions --filter    Browse with source/date filter step
  npx code-session-memory sessions print <id>  Print all chunks of a session to stdout
  npx code-session-memory sessions delete <id> Delete a session from the DB
  npx code-session-memory help                 Show this help

${bold("Environment variables:")}
  OPENAI_API_KEY            Required for embedding generation
  OPENCODE_MEMORY_DB_PATH   Override the default DB path
  OPENCODE_CONFIG_DIR       Override the OpenCode config directory
  CLAUDE_CONFIG_DIR         Override the Claude Code config directory
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const cmd = process.argv[2] ?? "help";

switch (cmd) {
  case "install":   install();   break;
  case "status":    status();    break;
  case "uninstall": uninstall(); break;
  case "reset-db":  resetDb();   break;
  case "sessions":
    cmdSessions(process.argv.slice(3)).catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
    break;
  case "help":
  case "--help":
  case "-h":        help();      break;
  default:
    console.error(`Unknown command: ${cmd}`);
    help();
    process.exit(1);
}
