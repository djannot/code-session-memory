#!/usr/bin/env node
/**
 * code-session-memory CLI
 *
 * Usage:
 *   npx code-session-memory install        — install for all detected supported tools
 *   npx code-session-memory status         — show installation status
 *   npx code-session-memory uninstall      — remove all installed components
 *   npx code-session-memory reset-db       — wipe the database (with confirmation)
 *   npx code-session-memory sessions       — browse / print / delete sessions
 */

import fs from "fs";
import path from "path";
import os from "os";
import * as clack from "@clack/prompts";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { resolveDbPath, openDatabase } from "./database";
import { cmdSessions } from "./cli-sessions";
import { cmdQuery } from "./cli-query";
import {
  resolveNodeExecutable,
  isResolvedNodePath,
  buildNodeCommand,
  hydrateEnv,
  captureEnvFromProcess,
  saveEnvSnapshot,
  loadEnvSnapshot,
  getEnvFilePath,
  maskEnvValue,
  SNAPSHOT_ENV_KEYS,
  REQUIRED_ENV_KEYS,
} from "./runtime-env";
import { getHookLogPath, readHookLog } from "./hook-log";

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
  return path.join(getOpenCodeConfigDir(), "skills", "code-session-memory", "SKILL.md");
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

function getClaudeSkillDst(): string {
  return path.join(getClaudeConfigDir(), "skills", "code-session-memory", "SKILL.md");
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

function getIndexerCliCursorPath(): string {
  return path.join(getPackageRoot(), "dist", "src", "indexer-cli-cursor.js");
}

function getIndexerCliVscodePath(): string {
  return path.join(getPackageRoot(), "dist", "src", "indexer-cli-vscode.js");
}

function getIndexerCliCodexPath(): string {
  return path.join(getPackageRoot(), "dist", "src", "indexer-cli-codex.js");
}

function getIndexerCliGeminiPath(): string {
  return path.join(getPackageRoot(), "dist", "src", "indexer-cli-gemini.js");
}

// ---------------------------------------------------------------------------
// Paths — Cursor
// ---------------------------------------------------------------------------

function getCursorConfigDir(): string {
  const envDir = process.env.CURSOR_CONFIG_DIR;
  if (envDir) return envDir;
  return path.join(os.homedir(), ".cursor");
}

function getCursorHooksPath(): string {
  return path.join(getCursorConfigDir(), "hooks.json");
}

function getCursorHooksScriptDir(): string {
  return path.join(getCursorConfigDir(), "hooks");
}

function getCursorMcpConfigPath(): string {
  return path.join(getCursorConfigDir(), "mcp.json");
}

function getCursorSkillDst(): string {
  return path.join(getCursorConfigDir(), "skills", "code-session-memory", "SKILL.md");
}

// ---------------------------------------------------------------------------
// Paths — VS Code
// ---------------------------------------------------------------------------

function getVscodeConfigDir(): string {
  const envDir = process.env.VSCODE_CONFIG_DIR;
  if (envDir) return envDir;
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Code", "User");
  }
  // Linux (and fallback)
  return path.join(os.homedir(), ".config", "Code", "User");
}

function getVscodeSettingsPath(): string {
  return path.join(getVscodeConfigDir(), "settings.json");
}

function getVscodeMcpConfigPath(): string {
  return path.join(getVscodeConfigDir(), "mcp.json");
}

function getVscodeHooksPath(): string {
  return path.join(getVscodeConfigDir(), "hooks", "code-session-memory.json");
}

// ---------------------------------------------------------------------------
// Paths — Codex
// ---------------------------------------------------------------------------

function getCodexConfigDir(): string {
  const envDir = process.env.CODEX_HOME;
  if (envDir) return envDir;
  return path.join(os.homedir(), ".codex");
}

function getCodexConfigPath(): string {
  return path.join(getCodexConfigDir(), "config.toml");
}

function getCodexSkillDst(): string {
  return path.join(getCodexConfigDir(), "skills", "code-session-memory", "SKILL.md");
}

// ---------------------------------------------------------------------------
// Paths — Gemini CLI
// ---------------------------------------------------------------------------

function getGeminiConfigDir(): string {
  const envDir = process.env.GEMINI_CONFIG_DIR;
  if (envDir) return envDir;
  return path.join(os.homedir(), ".gemini");
}

function getGeminiSettingsPath(): string {
  return path.join(getGeminiConfigDir(), "settings.json");
}

function getGeminiSkillDst(): string {
  return path.join(getGeminiConfigDir(), "skills", "code-session-memory", "SKILL.md");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a JSONC string (JSON with comments and trailing commas).
 * VS Code's settings.json uses JSONC, so we need this to read it safely.
 */
function parseJsonc(text: string): unknown {
  // Remove single-line comments (// ...)
  // Remove multi-line comments (/* ... */)
  // Remove trailing commas before } or ]
  const stripped = text
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

/**
 * Reads a JSON file, returning {} for empty/whitespace-only files.
 * Throws a descriptive error for non-empty invalid JSON.
 */
function readJsonFileOrEmpty(filePath: string, parser: (text: string) => unknown = JSON.parse): Record<string, unknown> {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return {};
  try {
    return parser(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Could not parse existing ${filePath} — please check it is valid JSON.`);
  }
}

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
function installOpenCodePlugin(src: string, dst: string, nodePath: string): void {
  if (!fs.existsSync(src)) {
    throw new Error(`Plugin source not found: ${src}\nDid you run "npm run build" first?`);
  }
  let content = fs.readFileSync(src, "utf8");
  content = content.replace(
    '"OPENCODE_MEMORY_INDEXER_PATH"',
    JSON.stringify(getIndexerCliPath()),
  );
  content = content.replace(
    '"OPENCODE_MEMORY_NODE_PATH"',
    JSON.stringify(nodePath),
  );
  ensureDir(path.dirname(dst));
  fs.writeFileSync(dst, content, "utf8");
}

/**
 * Merges the code-session-memory MCP entry into the global opencode.json.
 */
function installOpenCodeMcpConfig(mcpServerPath: string, nodePath: string): { configPath: string; existed: boolean } {
  const configPath = getGlobalOpenCodeConfigPath();
  const existed = fs.existsSync(configPath);

  let config: Record<string, unknown> = { $schema: "https://opencode.ai/config.json" };
  if (existed) {
    config = { ...config, ...readJsonFileOrEmpty(configPath) };
  }

  if (!config.mcp || typeof config.mcp !== "object") config.mcp = {};
  (config.mcp as Record<string, unknown>)["code-session-memory"] = {
    type: "local",
    command: [nodePath, mcpServerPath],
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
function installClaudeHook(indexerCliClaudePath: string, nodePath: string): { settingsPath: string; existed: boolean } {
  const settingsPath = getClaudeSettingsPath();
  const existed = fs.existsSync(settingsPath);

  let settings: Record<string, unknown> = {};
  if (existed) {
    settings = readJsonFileOrEmpty(settingsPath);
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
        command: buildNodeCommand(nodePath, indexerCliClaudePath),
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

function installClaudeSkill(skillSrc: string): { dstPath: string; existed: boolean } {
  const dstPath = getClaudeSkillDst();
  const existed = fs.existsSync(dstPath);
  if (!fs.existsSync(skillSrc)) {
    throw new Error(`Skill source not found: ${skillSrc}\nDid you run "npm run build" first?`);
  }
  const skillBody = fs.readFileSync(skillSrc, "utf8");
  const bodyWithoutFrontmatter = skillBody.replace(/^---[\s\S]*?---\s*\n?/, "").trimStart();
  const frontmatter = [
    "---",
    "name: code-session-memory",
    "description: Search past OpenCode, Claude Code, Cursor, VS Code, Codex, and Gemini CLI sessions. Use when the user asks about past work, decisions, or implementations.",
    "---",
    "",
  ].join("\n");
  ensureDir(path.dirname(dstPath));
  fs.writeFileSync(dstPath, frontmatter + bodyWithoutFrontmatter, "utf8");
  // Migrate: clean up old CLAUDE.md injection if present
  uninstallClaudeMd();
  return { dstPath, existed };
}

function checkClaudeSkillInstalled(): boolean {
  return fs.existsSync(getClaudeSkillDst());
}

function uninstallClaudeSkill(): "done" | "not_found" {
  const dst = getClaudeSkillDst();
  if (!fs.existsSync(dst)) return "not_found";
  fs.rmSync(path.dirname(dst), { recursive: true, force: true });
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
function installClaudeMcpConfig(mcpServerPath: string, nodePath: string): { configPath: string; existed: boolean } {
  const configPath = getClaudeUserConfigPath();
  const existed = fs.existsSync(configPath);

  let config: Record<string, unknown> = {};
  if (existed) {
    config = readJsonFileOrEmpty(configPath);
  }

  if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
  (config.mcpServers as Record<string, unknown>)["code-session-memory"] = {
    type: "stdio",
    command: nodePath,
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
// Cursor — hook
// ---------------------------------------------------------------------------

/**
 * Installs/updates the Cursor stop hook in ~/.cursor/hooks.json.
 * Merges with any existing hooks — never clobbers other entries.
 */
function installCursorHook(indexerCliCursorPath: string, nodePath: string): { hooksPath: string; existed: boolean } {
  const hooksPath = getCursorHooksPath();
  const existed = fs.existsSync(hooksPath);

  let config: { version?: number; hooks?: Record<string, unknown[]> } = {};
  if (existed) {
    config = readJsonFileOrEmpty(hooksPath) as typeof config;
  }

  config.version = config.version ?? 1;
  if (!config.hooks || typeof config.hooks !== "object") config.hooks = {};

  // Remove any existing code-session-memory stop hook
  if (Array.isArray(config.hooks.stop)) {
    config.hooks.stop = config.hooks.stop.filter((entry: unknown) => {
      if (!entry || typeof entry !== "object") return true;
      const e = entry as Record<string, unknown>;
      return typeof e.command !== "string" || !e.command.includes("indexer-cli-cursor");
    });
  } else {
    config.hooks.stop = [];
  }

  config.hooks.stop.push({ command: buildNodeCommand(nodePath, indexerCliCursorPath) });

  ensureDir(path.dirname(hooksPath));
  fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { hooksPath, existed };
}

/**
 * Removes the code-session-memory stop hook from ~/.cursor/hooks.json.
 */
function uninstallCursorHook(): "done" | "not_found" {
  const hooksPath = getCursorHooksPath();
  if (!fs.existsSync(hooksPath)) return "not_found";
  try {
    const config = JSON.parse(fs.readFileSync(hooksPath, "utf8")) as {
      version?: number;
      hooks?: Record<string, unknown[]>;
    };
    const stop = config.hooks?.stop;
    if (!Array.isArray(stop)) return "not_found";

    const before = stop.length;
    config.hooks!.stop = stop.filter((entry: unknown) => {
      if (!entry || typeof entry !== "object") return true;
      const e = entry as Record<string, unknown>;
      return typeof e.command !== "string" || !e.command.includes("indexer-cli-cursor");
    });

    if (config.hooks!.stop.length === before) return "not_found";
    fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + "\n", "utf8");
    return "done";
  } catch {
    return "not_found";
  }
}

function checkCursorHookInstalled(): boolean {
  const hooksPath = getCursorHooksPath();
  try {
    const config = JSON.parse(fs.readFileSync(hooksPath, "utf8")) as {
      hooks?: Record<string, unknown[]>;
    };
    const stop = config.hooks?.stop;
    if (!Array.isArray(stop)) return false;
    return stop.some((entry: unknown) => {
      if (!entry || typeof entry !== "object") return false;
      const e = entry as Record<string, unknown>;
      return typeof e.command === "string" && e.command.includes("indexer-cli-cursor");
    });
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Cursor — MCP config
// ---------------------------------------------------------------------------

/**
 * Merges the code-session-memory MCP entry into ~/.cursor/mcp.json.
 */
function installCursorMcpConfig(mcpServerPath: string, nodePath: string): { configPath: string; existed: boolean } {
  const configPath = getCursorMcpConfigPath();
  const existed = fs.existsSync(configPath);

  let config: Record<string, unknown> = {};
  if (existed) {
    config = readJsonFileOrEmpty(configPath);
  }

  if (!config.mcpServers || typeof config.mcpServers !== "object") config.mcpServers = {};
  (config.mcpServers as Record<string, unknown>)["code-session-memory"] = {
    command: nodePath,
    args: [mcpServerPath],
    env: {},
  };

  ensureDir(path.dirname(configPath));
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { configPath, existed };
}

/**
 * Removes the code-session-memory MCP entry from ~/.cursor/mcp.json.
 */
function uninstallCursorMcpConfig(): "done" | "not_found" {
  const configPath = getCursorMcpConfigPath();
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

function checkCursorMcpConfigured(): boolean {
  const configPath = getCursorMcpConfigPath();
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    return !!(
      config.mcpServers &&
      typeof config.mcpServers === "object" &&
      "code-session-memory" in (config.mcpServers as object)
    );
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Cursor — skill
// ---------------------------------------------------------------------------

/**
 * Copies the shared skill file to ~/.cursor/skills/code-session-memory/SKILL.md,
 * prepending Cursor-compatible YAML frontmatter.
 */
function installCursorSkill(skillSrc: string): { dstPath: string; existed: boolean } {
  const dstPath = getCursorSkillDst();
  const existed = fs.existsSync(dstPath);

  if (!fs.existsSync(skillSrc)) {
    throw new Error(`Skill source not found: ${skillSrc}\nDid you run "npm run build" first?`);
  }

  const skillBody = fs.readFileSync(skillSrc, "utf8");

  // Strip any existing frontmatter (--- ... ---) before adding Cursor's
  const bodyWithoutFrontmatter = skillBody
    .replace(/^---[\s\S]*?---\s*\n?/, "")
    .trimStart();

  const cursorFrontmatter = [
    "---",
    "name: code-session-memory",
    "description: Search past AI coding sessions semantically across OpenCode, Claude Code, Cursor, VS Code, Codex, and Gemini CLI. Use this when the user asks about past work, decisions, or implementations.",
    "---",
    "",
  ].join("\n");

  ensureDir(path.dirname(dstPath));
  fs.writeFileSync(dstPath, cursorFrontmatter + bodyWithoutFrontmatter, "utf8");
  return { dstPath, existed };
}

/**
 * Removes the code-session-memory skill from ~/.cursor/skills/.
 */
function uninstallCursorSkill(): "done" | "not_found" {
  const dstPath = getCursorSkillDst();
  if (!fs.existsSync(dstPath)) return "not_found";
  fs.unlinkSync(dstPath);
  // Remove the directory if empty
  try {
    const dir = path.dirname(dstPath);
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* ignore */ }
  return "done";
}

// ---------------------------------------------------------------------------
// VS Code — hook
// ---------------------------------------------------------------------------

/**
 * Installs the VS Code Stop hook at ~/.vscode/hooks/code-session-memory.json
 * using the Copilot hook format.
 */
function installVscodeHook(indexerCliVscodePath: string, nodePath: string): { hooksPath: string; existed: boolean } {
  const hooksPath = getVscodeHooksPath();
  const existed = fs.existsSync(hooksPath);

  // Always overwrite with our hook config (this file is owned by us)
  const config = {
    hooks: {
      Stop: [
        {
          type: "command",
          command: buildNodeCommand(nodePath, indexerCliVscodePath),
        },
      ],
    },
  };

  ensureDir(path.dirname(hooksPath));
  fs.writeFileSync(hooksPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { hooksPath, existed };
}

/**
 * Removes the VS Code Stop hook file.
 */
function uninstallVscodeHook(): "done" | "not_found" {
  const hooksPath = getVscodeHooksPath();
  if (!fs.existsSync(hooksPath)) return "not_found";
  fs.unlinkSync(hooksPath);
  // Remove the directory if empty
  try {
    const dir = path.dirname(hooksPath);
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* ignore */ }
  return "done";
}

function checkVscodeHookInstalled(): boolean {
  const hooksPath = getVscodeHooksPath();
  try {
    const config = JSON.parse(fs.readFileSync(hooksPath, "utf8")) as {
      hooks?: Record<string, unknown[]>;
    };
    const stop = config.hooks?.Stop;
    if (!Array.isArray(stop)) return false;
    return stop.some((entry: unknown) => {
      if (!entry || typeof entry !== "object") return false;
      const e = entry as Record<string, unknown>;
      return typeof e.command === "string" && e.command.includes("indexer-cli-vscode");
    });
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// VS Code — hook location registration
// ---------------------------------------------------------------------------

/**
 * Returns the VS Code hooks path as a ~-prefixed string.
 * VS Code supports ~ in hookFilesLocations, which improves portability across
 * machines and avoids VS Code showing the fully-expanded path as an error.
 */
function getVscodeHooksPathTilde(): string {
  const hooksPath = getVscodeHooksPath();
  const home = os.homedir();
  if (hooksPath.startsWith(home + path.sep)) {
    return "~" + hooksPath.slice(home.length);
  }
  return hooksPath;
}

/**
 * Adds the hook file path to VS Code's settings.json under
 * `chat.hookFilesLocations` so VS Code discovers our hook.
 * Uses a ~-prefixed path for portability.
 */
function installVscodeHookLocation(): { settingsPath: string; existed: boolean } {
  const settingsPath = getVscodeSettingsPath();
  const existed = fs.existsSync(settingsPath);

  let settings: Record<string, unknown> = {};
  if (existed) {
    settings = readJsonFileOrEmpty(settingsPath, parseJsonc);
  }

  const hookLocations = (settings["chat.hookFilesLocations"] ?? {}) as Record<string, boolean>;
  // Remove any previously installed absolute path entry (migration)
  const absolutePath = getVscodeHooksPath();
  if (absolutePath in hookLocations) {
    delete hookLocations[absolutePath];
  }
  hookLocations[getVscodeHooksPathTilde()] = true;
  settings["chat.hookFilesLocations"] = hookLocations;

  ensureDir(path.dirname(settingsPath));
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return { settingsPath, existed };
}

/**
 * Removes our hook file path from VS Code's `chat.hookFilesLocations` setting.
 * Handles both ~ and absolute path variants.
 */
function uninstallVscodeHookLocation(): "done" | "not_found" {
  const settingsPath = getVscodeSettingsPath();
  if (!fs.existsSync(settingsPath)) return "not_found";
  try {
    const settings = parseJsonc(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const hookLocations = settings["chat.hookFilesLocations"] as Record<string, boolean> | undefined;
    if (!hookLocations) return "not_found";
    const tildePath = getVscodeHooksPathTilde();
    const absolutePath = getVscodeHooksPath();
    const foundTilde = tildePath in hookLocations;
    const foundAbsolute = absolutePath in hookLocations;
    if (!foundTilde && !foundAbsolute) return "not_found";
    if (foundTilde) delete hookLocations[tildePath];
    if (foundAbsolute) delete hookLocations[absolutePath];
    settings["chat.hookFilesLocations"] = hookLocations;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    return "done";
  } catch {
    return "not_found";
  }
}

function checkVscodeHookLocationRegistered(): boolean {
  const settingsPath = getVscodeSettingsPath();
  try {
    const settings = parseJsonc(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const hookLocations = settings["chat.hookFilesLocations"] as Record<string, boolean> | undefined;
    if (!hookLocations) return false;
    return hookLocations[getVscodeHooksPathTilde()] === true ||
      hookLocations[getVscodeHooksPath()] === true;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// VS Code — MCP config
// ---------------------------------------------------------------------------

/**
 * Merges the code-session-memory MCP entry into VS Code's mcp.json.
 */
function installVscodeMcpConfig(mcpServerPath: string, nodePath: string): { configPath: string; existed: boolean } {
  const configPath = getVscodeMcpConfigPath();
  const existed = fs.existsSync(configPath);

  let config: Record<string, unknown> = {};
  if (existed) {
    config = readJsonFileOrEmpty(configPath);
  }

  if (!config.servers || typeof config.servers !== "object") config.servers = {};
  (config.servers as Record<string, unknown>)["code-session-memory"] = {
    type: "stdio",
    command: nodePath,
    args: [mcpServerPath],
  };

  ensureDir(path.dirname(configPath));
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  return { configPath, existed };
}

/**
 * Removes the code-session-memory MCP entry from VS Code's mcp.json.
 */
function uninstallVscodeMcpConfig(): "done" | "not_found" {
  const configPath = getVscodeMcpConfigPath();
  if (!fs.existsSync(configPath)) return "not_found";
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    if (
      config.servers &&
      typeof config.servers === "object" &&
      "code-session-memory" in (config.servers as object)
    ) {
      delete (config.servers as Record<string, unknown>)["code-session-memory"];
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
      return "done";
    }
    return "not_found";
  } catch {
    return "not_found";
  }
}

function checkVscodeMcpConfigured(): boolean {
  const configPath = getVscodeMcpConfigPath();
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    return !!(
      config.servers &&
      typeof config.servers === "object" &&
      "code-session-memory" in (config.servers as object)
    );
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Codex — config.toml (TOML)
// ---------------------------------------------------------------------------

function parseCodexConfigOrEmpty(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, "utf8").trim();
  if (!raw) return {};
  try {
    return parseToml(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Could not parse existing ${configPath} — please check it is valid TOML.`);
  }
}

function mergeCodexEnvVarsPassthrough(existing: unknown): string[] {
  const values = Array.isArray(existing)
    ? existing.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  if (!values.includes("OPENAI_API_KEY")) values.push("OPENAI_API_KEY");
  return values;
}

function installCodexMcpConfig(mcpServerPath: string, nodePath: string): { configPath: string; existed: boolean } {
  const configPath = getCodexConfigPath();
  const existed = fs.existsSync(configPath);
  const config = parseCodexConfigOrEmpty(configPath);

  const mcpServersRaw = config.mcp_servers;
  const mcpServers =
    mcpServersRaw && typeof mcpServersRaw === "object"
      ? mcpServersRaw as Record<string, unknown>
      : {};
  const existingServer = mcpServers["code-session-memory"];
  const serverConfig =
    existingServer && typeof existingServer === "object"
      ? existingServer as Record<string, unknown>
      : {};

  mcpServers["code-session-memory"] = {
    ...serverConfig,
    command: nodePath,
    args: [mcpServerPath],
    // Codex MCP servers run with a restricted environment by default.
    // Pass-through env vars are configured via env_vars (env is a map of fixed values).
    env_vars: mergeCodexEnvVarsPassthrough(serverConfig.env_vars),
  };
  config.mcp_servers = mcpServers;

  ensureDir(path.dirname(configPath));
  fs.writeFileSync(configPath, stringifyToml(config) + "\n", "utf8");
  return { configPath, existed };
}

function uninstallCodexMcpConfig(): "done" | "not_found" {
  const configPath = getCodexConfigPath();
  if (!fs.existsSync(configPath)) return "not_found";
  try {
    const config = parseToml(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const mcpServers = config.mcp_servers as Record<string, unknown> | undefined;
    if (!mcpServers || !(Object.prototype.hasOwnProperty.call(mcpServers, "code-session-memory"))) {
      return "not_found";
    }
    delete mcpServers["code-session-memory"];
    fs.writeFileSync(configPath, stringifyToml(config) + "\n", "utf8");
    return "done";
  } catch {
    return "not_found";
  }
}

function checkCodexMcpConfigured(): boolean {
  const configPath = getCodexConfigPath();
  try {
    const config = parseToml(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const mcpServers = config.mcp_servers as Record<string, unknown> | undefined;
    return !!(mcpServers && Object.prototype.hasOwnProperty.call(mcpServers, "code-session-memory"));
  } catch {
    return false;
  }
}

function checkCodexOpenAiPassthroughConfigured(): boolean {
  const configPath = getCodexConfigPath();
  try {
    const config = parseToml(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const mcpServers = config.mcp_servers as Record<string, unknown> | undefined;
    const server = mcpServers?.["code-session-memory"];
    if (!server || typeof server !== "object") return false;
    const envVars = (server as Record<string, unknown>).env_vars;
    return Array.isArray(envVars) && envVars.includes("OPENAI_API_KEY");
  } catch {
    return false;
  }
}

function installCodexHook(indexerCliCodexPath: string, nodePath: string): { configPath: string; existed: boolean } {
  const configPath = getCodexConfigPath();
  const existed = fs.existsSync(configPath);
  const config = parseCodexConfigOrEmpty(configPath);

  config.notify = [nodePath, indexerCliCodexPath];

  ensureDir(path.dirname(configPath));
  fs.writeFileSync(configPath, stringifyToml(config) + "\n", "utf8");
  return { configPath, existed };
}

function uninstallCodexHook(): "done" | "not_found" {
  const configPath = getCodexConfigPath();
  if (!fs.existsSync(configPath)) return "not_found";
  try {
    const config = parseToml(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const notify = config.notify;
    if (!Array.isArray(notify)) return "not_found";
    const hasOurHook = notify.some((v) => typeof v === "string" && v.includes("indexer-cli-codex"));
    if (!hasOurHook) return "not_found";
    delete config.notify;
    fs.writeFileSync(configPath, stringifyToml(config) + "\n", "utf8");
    return "done";
  } catch {
    return "not_found";
  }
}

function checkCodexHookInstalled(): boolean {
  const configPath = getCodexConfigPath();
  try {
    const config = parseToml(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const notify = config.notify;
    if (!Array.isArray(notify)) return false;
    return notify.some((v) => typeof v === "string" && v.includes("indexer-cli-codex"));
  } catch {
    return false;
  }
}

function installCodexSkill(skillSrc: string): { dstPath: string; existed: boolean } {
  const dstPath = getCodexSkillDst();
  const existed = fs.existsSync(dstPath);

  if (!fs.existsSync(skillSrc)) {
    throw new Error(`Skill source not found: ${skillSrc}\nDid you run "npm run build" first?`);
  }

  const skillBody = fs.readFileSync(skillSrc, "utf8");
  const bodyWithoutFrontmatter = skillBody
    .replace(/^---[\s\S]*?---\s*\n?/, "")
    .trimStart();
  const codexFrontmatter = [
    "---",
    "name: code-session-memory",
    "description: Search past AI coding sessions semantically across OpenCode, Claude Code, Cursor, VS Code, Codex, and Gemini CLI.",
    "---",
    "",
  ].join("\n");

  ensureDir(path.dirname(dstPath));
  fs.writeFileSync(dstPath, codexFrontmatter + bodyWithoutFrontmatter, "utf8");
  return { dstPath, existed };
}

function uninstallCodexSkill(): "done" | "not_found" {
  const dstPath = getCodexSkillDst();
  if (!fs.existsSync(dstPath)) return "not_found";
  fs.unlinkSync(dstPath);
  try {
    const dir = path.dirname(dstPath);
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* ignore */ }
  return "done";
}

// ---------------------------------------------------------------------------
// Gemini CLI — settings.json
// ---------------------------------------------------------------------------

function parseGeminiSettingsOrEmpty(settingsPath: string): Record<string, unknown> {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, "utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error(`Could not parse existing ${settingsPath} — please check it is valid JSON.`);
  }
}

function installGeminiMcpConfig(mcpServerPath: string, nodePath: string): { settingsPath: string; existed: boolean } {
  const settingsPath = getGeminiSettingsPath();
  const existed = fs.existsSync(settingsPath);
  const settings = parseGeminiSettingsOrEmpty(settingsPath);

  const mcpServersRaw = settings.mcpServers;
  const mcpServers =
    mcpServersRaw && typeof mcpServersRaw === "object"
      ? mcpServersRaw as Record<string, unknown>
      : {};

  mcpServers["code-session-memory"] = {
    type: "stdio",
    command: nodePath,
    args: [mcpServerPath],
  };
  settings.mcpServers = mcpServers;

  ensureDir(path.dirname(settingsPath));
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return { settingsPath, existed };
}

function uninstallGeminiMcpConfig(): "done" | "not_found" {
  const settingsPath = getGeminiSettingsPath();
  if (!fs.existsSync(settingsPath)) return "not_found";
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    if (
      settings.mcpServers &&
      typeof settings.mcpServers === "object" &&
      "code-session-memory" in (settings.mcpServers as object)
    ) {
      delete (settings.mcpServers as Record<string, unknown>)["code-session-memory"];
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
      return "done";
    }
    return "not_found";
  } catch {
    return "not_found";
  }
}

function checkGeminiMcpConfigured(): boolean {
  const settingsPath = getGeminiSettingsPath();
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    return !!(
      settings.mcpServers &&
      typeof settings.mcpServers === "object" &&
      "code-session-memory" in (settings.mcpServers as object)
    );
  } catch {
    return false;
  }
}

function installGeminiHook(indexerCliGeminiPath: string, nodePath: string): { settingsPath: string; existed: boolean } {
  const settingsPath = getGeminiSettingsPath();
  const existed = fs.existsSync(settingsPath);
  const settings = parseGeminiSettingsOrEmpty(settingsPath);

  const hooksRaw = settings.hooks;
  const hooks =
    hooksRaw && typeof hooksRaw === "object"
      ? hooksRaw as Record<string, unknown>
      : {};

  const afterAgentRaw = Array.isArray(hooks.AfterAgent) ? hooks.AfterAgent : [];
  const cleanedGroups: unknown[] = [];

  for (const entry of afterAgentRaw) {
    if (!entry || typeof entry !== "object") continue;
    const group = entry as Record<string, unknown>;
    if (!Array.isArray(group.hooks)) continue;
    const filteredHooks = group.hooks.filter((h: unknown) => {
      if (!h || typeof h !== "object") return true;
      const hook = h as Record<string, unknown>;
      return typeof hook.command !== "string" || !hook.command.includes("indexer-cli-gemini");
    });
    if (filteredHooks.length > 0) {
      cleanedGroups.push({ ...group, hooks: filteredHooks });
    }
  }

  cleanedGroups.push({
    hooks: [
      {
        type: "command",
        name: "code-session-memory-indexer",
        command: buildNodeCommand(nodePath, indexerCliGeminiPath),
      },
    ],
  });

  hooks.AfterAgent = cleanedGroups;
  settings.hooks = hooks;

  ensureDir(path.dirname(settingsPath));
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return { settingsPath, existed };
}

function uninstallGeminiHook(): "done" | "not_found" {
  const settingsPath = getGeminiSettingsPath();
  if (!fs.existsSync(settingsPath)) return "not_found";
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const hooks = settings.hooks as Record<string, unknown> | undefined;
    const afterAgent = hooks?.AfterAgent;
    if (!Array.isArray(afterAgent)) return "not_found";

    let removed = false;
    const filteredGroups: unknown[] = [];

    for (const entry of afterAgent) {
      if (!entry || typeof entry !== "object") continue;
      const group = entry as Record<string, unknown>;

      // Legacy shape support: { command: "..." }
      if (typeof group.command === "string") {
        if (group.command.includes("indexer-cli-gemini")) {
          removed = true;
          continue;
        }
        filteredGroups.push(group);
        continue;
      }

      if (!Array.isArray(group.hooks)) {
        filteredGroups.push(group);
        continue;
      }

      const filteredHooks = group.hooks.filter((h: unknown) => {
        if (!h || typeof h !== "object") return true;
        const hook = h as Record<string, unknown>;
        const keep = typeof hook.command !== "string" || !hook.command.includes("indexer-cli-gemini");
        if (!keep) removed = true;
        return keep;
      });

      if (filteredHooks.length > 0) {
        filteredGroups.push({ ...group, hooks: filteredHooks });
      }
    }

    if (!removed) return "not_found";
    hooks!.AfterAgent = filteredGroups;
    settings.hooks = hooks!;
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
    return "done";
  } catch {
    return "not_found";
  }
}

function checkGeminiHookInstalled(): boolean {
  const settingsPath = getGeminiSettingsPath();
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const hooks = settings.hooks as Record<string, unknown> | undefined;
    const afterAgent = hooks?.AfterAgent;
    if (!Array.isArray(afterAgent)) return false;
    return afterAgent.some((entry: unknown) => {
      if (!entry || typeof entry !== "object") return false;
      const group = entry as Record<string, unknown>;

      // Legacy shape support: { command: "..." }
      if (typeof group.command === "string" && group.command.includes("indexer-cli-gemini")) {
        return true;
      }

      if (!Array.isArray(group.hooks)) return false;
      return group.hooks.some((h: unknown) => {
        if (!h || typeof h !== "object") return false;
        const hook = h as Record<string, unknown>;
        return typeof hook.command === "string" && hook.command.includes("indexer-cli-gemini");
      });
    });
  } catch {
    return false;
  }
}

function installGeminiSkill(skillSrc: string): { dstPath: string; existed: boolean } {
  const dstPath = getGeminiSkillDst();
  const existed = fs.existsSync(dstPath);

  if (!fs.existsSync(skillSrc)) {
    throw new Error(`Skill source not found: ${skillSrc}\nDid you run "npm run build" first?`);
  }

  const skillBody = fs.readFileSync(skillSrc, "utf8");
  const bodyWithoutFrontmatter = skillBody
    .replace(/^---[\s\S]*?---\s*\n?/, "")
    .trimStart();
  const geminiFrontmatter = [
    "---",
    "name: code-session-memory",
    "description: Search past AI coding sessions semantically across OpenCode, Claude Code, Cursor, VS Code, Codex, and Gemini CLI.",
    "---",
    "",
  ].join("\n");

  ensureDir(path.dirname(dstPath));
  fs.writeFileSync(dstPath, geminiFrontmatter + bodyWithoutFrontmatter, "utf8");
  return { dstPath, existed };
}

function uninstallGeminiSkill(): "done" | "not_found" {
  const dstPath = getGeminiSkillDst();
  if (!fs.existsSync(dstPath)) return "not_found";
  fs.unlinkSync(dstPath);
  try {
    const dir = path.dirname(dstPath);
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch { /* ignore */ }
  return "done";
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function bold(s: string): string { return `\x1b[1m${s}\x1b[0m`; }
function green(s: string): string { return `\x1b[32m${s}\x1b[0m`; }
function red(s: string): string { return `\x1b[31m${s}\x1b[0m`; }
function dim(s: string): string { return `\x1b[2m${s}\x1b[0m`; }
function ok(v: boolean): string { return v ? green("✓") : red("✗"); }

// ---------------------------------------------------------------------------
// Tool detection
// ---------------------------------------------------------------------------

function isOpenCodeInstalled(): boolean {
  return fs.existsSync(getOpenCodeConfigDir());
}

function isClaudeCodeInstalled(): boolean {
  return fs.existsSync(getClaudeConfigDir());
}

function isCursorInstalled(): boolean {
  return fs.existsSync(getCursorConfigDir());
}

function isVscodeInstalled(): boolean {
  return fs.existsSync(getVscodeConfigDir());
}

function isCodexInstalled(): boolean {
  return fs.existsSync(getCodexConfigDir());
}

function isGeminiInstalled(): boolean {
  return fs.existsSync(getGeminiConfigDir());
}

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

function stepIf(condition: boolean, label: string, fn: () => string): void {
  if (!condition) {
    console.log(`  ${dim("○")}  ${dim(label)}  ${dim("(tool not detected — skipped)")}`);
    return;
  }
  step(label, fn);
}

// ---------------------------------------------------------------------------
// Runtime diagnostics — is the node binary baked into the configs still valid?
// ---------------------------------------------------------------------------

/** Extracts the executable from a hook command string (handles quoting). */
function commandExecutable(command: string): string {
  const quoted = /^\s*"([^"]+)"/.exec(command);
  if (quoted) return quoted[1];
  return command.trim().split(/\s+/)[0] ?? "";
}

function jsonHookCommands(filePath: string, pick: (config: Record<string, unknown>) => string[]): string[] {
  try {
    return pick(parseJsonc(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>);
  } catch {
    return [];
  }
}

function nestedHookCommands(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const group of value) {
    if (!group || typeof group !== "object") continue;
    const hooks = (group as Record<string, unknown>).hooks;
    if (!Array.isArray(hooks)) continue;
    for (const hook of hooks) {
      const command = (hook as Record<string, unknown> | null)?.command;
      if (typeof command === "string") out.push(command);
    }
  }
  return out;
}

function flatHookCommands(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (entry as Record<string, unknown> | null)?.command)
    .filter((command): command is string => typeof command === "string");
}

/**
 * Collects every executable the installed configs will invoke, so status can
 * tell the user when a recorded node path has gone stale (a version manager
 * removed it) or was never resolved (bare "node", which fails under a
 * GUI-launched host).
 */
function collectConfiguredExecutables(): Array<{ label: string; exec: string }> {
  const out: Array<{ label: string; exec: string }> = [];
  const add = (label: string, exec: string | undefined | null) => {
    if (typeof exec === "string" && exec.trim().length > 0) out.push({ label, exec: exec.trim() });
  };

  // OpenCode plugin (node path is baked into the generated file)
  try {
    const plugin = fs.readFileSync(getOpenCodePluginDst(), "utf8");
    const match = /const NODE_BIN = "([^"]+)"/.exec(plugin);
    if (match) add("OpenCode plugin", match[1]);
  } catch { /* not installed */ }

  for (const command of jsonHookCommands(getClaudeSettingsPath(), (c) =>
    nestedHookCommands((c.hooks as Record<string, unknown> | undefined)?.Stop).filter((x) => x.includes("indexer-cli-claude")),
  )) add("Claude Code hook", commandExecutable(command));

  for (const command of jsonHookCommands(getCursorHooksPath(), (c) =>
    flatHookCommands((c.hooks as Record<string, unknown> | undefined)?.stop).filter((x) => x.includes("indexer-cli-cursor")),
  )) add("Cursor hook", commandExecutable(command));

  for (const command of jsonHookCommands(getVscodeHooksPath(), (c) =>
    flatHookCommands((c.hooks as Record<string, unknown> | undefined)?.Stop).filter((x) => x.includes("indexer-cli-vscode")),
  )) add("VS Code hook", commandExecutable(command));

  for (const command of jsonHookCommands(getGeminiSettingsPath(), (c) =>
    nestedHookCommands((c.hooks as Record<string, unknown> | undefined)?.AfterAgent).filter((x) => x.includes("indexer-cli-gemini")),
  )) add("Gemini CLI hook", commandExecutable(command));

  try {
    const config = parseToml(fs.readFileSync(getCodexConfigPath(), "utf8")) as Record<string, unknown>;
    const notify = config.notify;
    if (Array.isArray(notify) && typeof notify[0] === "string") add("Codex notify hook", notify[0]);
    const server = (config.mcp_servers as Record<string, unknown> | undefined)?.["code-session-memory"];
    add("Codex MCP server", (server as Record<string, unknown> | undefined)?.command as string | undefined);
  } catch { /* not installed */ }

  add("Claude Code MCP server", jsonMcpCommand(getClaudeUserConfigPath(), "mcpServers"));
  add("Cursor MCP server", jsonMcpCommand(getCursorMcpConfigPath(), "mcpServers"));
  add("VS Code MCP server", jsonMcpCommand(getVscodeMcpConfigPath(), "servers"));
  add("Gemini CLI MCP server", jsonMcpCommand(getGeminiSettingsPath(), "mcpServers"));

  try {
    const config = parseJsonc(fs.readFileSync(getGlobalOpenCodeConfigPath(), "utf8")) as Record<string, unknown>;
    const server = (config.mcp as Record<string, unknown> | undefined)?.["code-session-memory"];
    const command = (server as Record<string, unknown> | undefined)?.command;
    if (Array.isArray(command) && typeof command[0] === "string") add("OpenCode MCP server", command[0]);
  } catch { /* not installed */ }

  return out;
}

function jsonMcpCommand(filePath: string, key: string): string | undefined {
  try {
    const config = parseJsonc(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
    const servers = config[key] as Record<string, unknown> | undefined;
    const server = servers?.["code-session-memory"] as Record<string, unknown> | undefined;
    const command = server?.command;
    return typeof command === "string" ? command : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function install(): void {
  console.log(bold("\ncode-session-memory install\n"));

  // Resolve the configured backend first: a PostgreSQL user must never need
  // the SQLite native module just to install hooks and MCP config.
  const { resolveBackendConfig } = require("./config") as typeof import("./config");
  let backendConfig: import("./config").DatabaseBackendConfig;
  try {
    backendConfig = resolveBackendConfig();
  } catch {
    backendConfig = { backend: "sqlite", dbPath: resolveDbPath() };
  }
  const isPostgres = backendConfig.backend === "postgres";
  const dbPath = isPostgres
    ? (backendConfig as import("./config").PostgresBackendConfig).connectionString.replace(/:[^:@]*@/, ":***@")
    : (backendConfig as import("./config").SqliteBackendConfig).dbPath;
  // GUI-launched hosts (the Claude desktop app under launchd, a Windows/Linux
  // desktop launcher) give hooks a bare environment: no shell profile, so no
  // `node` on PATH and no exported API key. Bake an absolute node path into
  // every command and snapshot the variables the hooks need.
  const nodePath = resolveNodeExecutable();
  const envState = hydrateEnv();
  let capturedEnv: Record<string, string> = {};

  const mcpPath = getMcpServerPath();
  const indexerClaudePath = getIndexerCliClaudePath();
  const indexerCursorPath = getIndexerCliCursorPath();
  const indexerVscodePath = getIndexerCliVscodePath();
  const indexerCodexPath = getIndexerCliCodexPath();
  const indexerGeminiPath = getIndexerCliGeminiPath();
  const openCodeInstalled = isOpenCodeInstalled();
  const claudeInstalled = isClaudeCodeInstalled();
  const cursorInstalled = isCursorInstalled();
  const vscodeInstalled = isVscodeInstalled();
  const codexInstalled = isCodexInstalled();
  const geminiInstalled = isGeminiInstalled();

  // 1. DB
  if (isPostgres) {
    // Schema creation and migrations run on every connection (see
    // PgDatabaseProvider.initialize), and `config set-backend postgres`
    // already verified the connection — nothing to do here.
    console.log(`  ${dim("○")}  ${dim("Initialising database")}  ${dim(`(PostgreSQL backend configured: ${dbPath} — skipped)`)}`);
  } else {
    step("Initialising database", () => {
      ensureDir(path.dirname(dbPath));
      const db = openDatabase({ dbPath });
      db.close();
      return dbPath;
    });
  }

  // Environment snapshot — hooks under a GUI-launched host see no shell
  // profile, so the variables they need are recorded here instead.
  step("Recording environment for GUI-launched apps", () => {
    capturedEnv = saveEnvSnapshot(captureEnvFromProcess());
    const count = SNAPSHOT_ENV_KEYS.filter((key) => capturedEnv[key]).length;
    const from = envState.fromShell.length > 0
      ? ` — ${envState.fromShell.join(", ")} read from your login shell`
      : "";
    return `${count} variable(s) → ${getEnvFilePath()}${from}`;
  });

  // OpenCode
  stepIf(openCodeInstalled, "Installing OpenCode plugin", () => {
    const dst = getOpenCodePluginDst();
    installOpenCodePlugin(getPluginSrc(), dst, nodePath);
    return dst;
  });

  stepIf(openCodeInstalled, "Installing OpenCode skill", () => {
    const dst = getOpenCodeSkillDst();
    copyFile(getSkillSrc(), dst);
    return dst;
  });

  stepIf(openCodeInstalled, "Configuring OpenCode MCP server", () => {
    const { configPath, existed } = installOpenCodeMcpConfig(mcpPath, nodePath);
    return `${existed ? "updated" : "created"} ${configPath}`;
  });

  // Claude Code
  stepIf(claudeInstalled, "Configuring Claude Code MCP server", () => {
    const { configPath, existed } = installClaudeMcpConfig(mcpPath, nodePath);
    return `${existed ? "updated" : "created"} ${configPath}`;
  });

  stepIf(claudeInstalled, "Installing Claude Code Stop hook", () => {
    const { settingsPath, existed } = installClaudeHook(indexerClaudePath, nodePath);
    return `${existed ? "updated" : "created"} ${settingsPath}`;
  });

  stepIf(claudeInstalled, "Installing Claude Code skill", () => {
    const { dstPath, existed } = installClaudeSkill(getSkillSrc());
    return `${existed ? "updated" : "created"} ${dstPath}`;
  });

  // Cursor
  stepIf(cursorInstalled, "Configuring Cursor MCP server", () => {
    const { configPath, existed } = installCursorMcpConfig(mcpPath, nodePath);
    return `${existed ? "updated" : "created"} ${configPath}`;
  });

  stepIf(cursorInstalled, "Installing Cursor stop hook", () => {
    const { hooksPath, existed } = installCursorHook(indexerCursorPath, nodePath);
    return `${existed ? "updated" : "created"} ${hooksPath}`;
  });

  stepIf(cursorInstalled, "Installing Cursor skill", () => {
    const { dstPath, existed } = installCursorSkill(getSkillSrc());
    return `${existed ? "updated" : "created"} ${dstPath}`;
  });

  // VS Code
  stepIf(vscodeInstalled, "Configuring VS Code MCP server", () => {
    const { configPath, existed } = installVscodeMcpConfig(mcpPath, nodePath);
    return `${existed ? "updated" : "created"} ${configPath}`;
  });

  stepIf(vscodeInstalled, "Installing VS Code Stop hook", () => {
    const { hooksPath, existed } = installVscodeHook(indexerVscodePath, nodePath);
    return `${existed ? "updated" : "created"} ${hooksPath}`;
  });

  stepIf(vscodeInstalled, "Registering VS Code hook location", () => {
    const { settingsPath, existed } = installVscodeHookLocation();
    return `${existed ? "updated" : "created"} ${settingsPath}`;
  });

  // Codex
  stepIf(codexInstalled, "Configuring Codex MCP server", () => {
    const { configPath, existed } = installCodexMcpConfig(mcpPath, nodePath);
    return `${existed ? "updated" : "created"} ${configPath}`;
  });

  stepIf(codexInstalled, "Installing Codex notify hook", () => {
    const { configPath, existed } = installCodexHook(indexerCodexPath, nodePath);
    return `${existed ? "updated" : "created"} ${configPath}`;
  });

  stepIf(codexInstalled, "Installing Codex skill", () => {
    const { dstPath, existed } = installCodexSkill(getSkillSrc());
    return `${existed ? "updated" : "created"} ${dstPath}`;
  });

  // Gemini CLI
  stepIf(geminiInstalled, "Configuring Gemini CLI MCP server", () => {
    const { settingsPath, existed } = installGeminiMcpConfig(mcpPath, nodePath);
    return `${existed ? "updated" : "created"} ${settingsPath}`;
  });

  stepIf(geminiInstalled, "Installing Gemini CLI AfterAgent hook", () => {
    const { settingsPath, existed } = installGeminiHook(indexerGeminiPath, nodePath);
    return `${existed ? "updated" : "created"} ${settingsPath}`;
  });

  stepIf(geminiInstalled, "Installing Gemini CLI skill", () => {
    const { dstPath, existed } = installGeminiSkill(getSkillSrc());
    return `${existed ? "updated" : "created"} ${dstPath}`;
  });

  const capturedKeys = SNAPSHOT_ENV_KEYS.filter((key) => capturedEnv[key]);
  const missingEnv = REQUIRED_ENV_KEYS.filter((key) => !capturedEnv[key]);

  console.log(`
${bold("Installation complete!")}

${bold("Node binary used by hooks:")} ${nodePath}${isResolvedNodePath(nodePath) ? "" : dim("  (could not be resolved to an absolute path — hooks will rely on PATH)")}
${bold("Environment snapshot:")} ${getEnvFilePath()}
  ${capturedKeys.length > 0 ? capturedKeys.map((key) => `${key}=${maskEnvValue(key, capturedEnv[key])}`).join("\n  ") : dim("(empty)")}
${missingEnv.length > 0
    ? `
${bold("Warning:")} ${missingEnv.join(", ")} not found in this shell or in the snapshot.
  Indexing will fail until you set it. Either re-run install from a shell that
  exports it, or run: ${bold(`code-session-memory config set-env OPENAI_API_KEY=sk-...`)}
`
    : ""}
${bold(isPostgres ? "Database backend:" : "Default DB path:")} ${dbPath}

${bold("Hook log:")} ${getHookLogPath()}

Restart ${bold("OpenCode")}, ${bold("Claude Code")}, ${bold("Cursor")}, ${bold("VS Code")}, ${bold("Codex")}, and ${bold("Gemini CLI")} to activate.
Desktop apps (Claude desktop, Cursor, VS Code) must be fully quit and relaunched.

${bold("VS Code note:")} Ensure ${bold("Chat: Use Hooks")} is enabled in VS Code settings.
${bold("Codex note:")} The notify hook and OPENAI_API_KEY passthrough are set in ${dim(getCodexConfigPath())}.
${bold("Gemini CLI note:")} The AfterAgent hook is configured in ${dim(getGeminiSettingsPath())}.
Run ${bold("npx code-session-memory status")} to verify.
`);
}

function status(): void {
  const { resolveBackendConfig } = require("./config") as typeof import("./config");
  let backendConfig: import("./config").DatabaseBackendConfig;
  try {
    backendConfig = resolveBackendConfig();
  } catch {
    backendConfig = { backend: "sqlite", dbPath: resolveDbPath() };
  }

  console.log(bold("\ncode-session-memory status\n"));

  const dbPath = backendConfig.backend === "postgres"
    ? (backendConfig as import("./config").PostgresBackendConfig).connectionString.replace(/:[^:@]*@/, ":***@")
    : (backendConfig as import("./config").SqliteBackendConfig).dbPath;
  const mcpPath = getMcpServerPath();
  const openCodeInstalled = isOpenCodeInstalled();
  const claudeInstalled = isClaudeCodeInstalled();
  const cursorInstalled = isCursorInstalled();
  const vscodeInstalled = isVscodeInstalled();
  const codexInstalled = isCodexInstalled();
  const geminiInstalled = isGeminiInstalled();

  if (openCodeInstalled) {
    console.log(bold("  OpenCode"));
    console.log(`  ${ok(fs.existsSync(getOpenCodePluginDst()))}  Plugin      ${dim(getOpenCodePluginDst())}`);
    console.log(`  ${ok(fs.existsSync(getOpenCodeSkillDst()))}  Skill       ${dim(getOpenCodeSkillDst())}`);
    console.log(`  ${ok(checkMcpConfigured())}  MCP config  ${dim(getGlobalOpenCodeConfigPath())}`);
  } else {
    console.log(bold("  OpenCode") + dim("  (not installed — skipped)"));
  }

  if (claudeInstalled) {
    console.log(bold("\n  Claude Code"));
    console.log(`  ${ok(checkClaudeMcpConfigured())}  MCP config  ${dim(getClaudeUserConfigPath())}`);
    console.log(`  ${ok(checkClaudeHookInstalled())}  Stop hook   ${dim(getClaudeSettingsPath())}`);
    console.log(`  ${ok(checkClaudeSkillInstalled())}  Skill       ${dim(getClaudeSkillDst())}`);
  } else {
    console.log(bold("\n  Claude Code") + dim("  (not installed — skipped)"));
  }

  if (cursorInstalled) {
    console.log(bold("\n  Cursor"));
    console.log(`  ${ok(checkCursorMcpConfigured())}  MCP config  ${dim(getCursorMcpConfigPath())}`);
    console.log(`  ${ok(checkCursorHookInstalled())}  Stop hook   ${dim(getCursorHooksPath())}`);
    console.log(`  ${ok(fs.existsSync(getCursorSkillDst()))}  Skill       ${dim(getCursorSkillDst())}`);
  } else {
    console.log(bold("\n  Cursor") + dim("  (not installed — skipped)"));
  }

  if (vscodeInstalled) {
    console.log(bold("\n  VS Code"));
    console.log(`  ${ok(checkVscodeMcpConfigured())}  MCP config  ${dim(getVscodeMcpConfigPath())}`);
    console.log(`  ${ok(checkVscodeHookInstalled())}  Stop hook   ${dim(getVscodeHooksPath())}`);
    console.log(`  ${ok(checkVscodeHookLocationRegistered())}  Hook loc    ${dim(getVscodeSettingsPath())}`);
  } else {
    console.log(bold("\n  VS Code") + dim("  (not installed — skipped)"));
  }

  if (codexInstalled) {
    console.log(bold("\n  Codex"));
    console.log(`  ${ok(checkCodexMcpConfigured())}  MCP config  ${dim(getCodexConfigPath())}`);
    console.log(`  ${ok(checkCodexOpenAiPassthroughConfigured())}  OPENAI_KEY ${dim(getCodexConfigPath())}`);
    console.log(`  ${ok(checkCodexHookInstalled())}  Notify hook ${dim(getCodexConfigPath())}`);
    console.log(`  ${ok(fs.existsSync(getCodexSkillDst()))}  Skill       ${dim(getCodexSkillDst())}`);
  } else {
    console.log(bold("\n  Codex") + dim("  (not installed — skipped)"));
  }

  if (geminiInstalled) {
    console.log(bold("\n  Gemini CLI"));
    console.log(`  ${ok(checkGeminiMcpConfigured())}  MCP config  ${dim(getGeminiSettingsPath())}`);
    console.log(`  ${ok(checkGeminiHookInstalled())}  AfterAgent  ${dim(getGeminiSettingsPath())}`);
    console.log(`  ${ok(fs.existsSync(getGeminiSkillDst()))}  Skill       ${dim(getGeminiSkillDst())}`);
  } else {
    console.log(bold("\n  Gemini CLI") + dim("  (not installed — skipped)"));
  }

  console.log(bold("\n  Shared"));
  console.log(`  ${ok(fs.existsSync(mcpPath))}  MCP server  ${dim(mcpPath)}`);

  printRuntimeStatus();

  if (backendConfig.backend === "postgres") {
    console.log(`  ${ok(true)}  Database    ${dim(`postgres: ${dbPath}`)}`);
    // Fetch stats async from Postgres
    (async () => {
      try {
        const { createProvider } = require("./providers") as typeof import("./providers");
        const provider = await createProvider(backendConfig);
        try {
          const overview = await provider.getOverviewStats();
          const sessions = await provider.listSessions();
          const totalChunks = sessions.reduce((n: number, s: { chunk_count: number }) => n + s.chunk_count, 0);
          const sourceMap = new Map<string, number>();
          for (const s of sessions) sourceMap.set(s.source, (sourceMap.get(s.source) ?? 0) + 1);

          console.log(`\n  ${dim("Backend:          ")}PostgreSQL`);
          console.log(`  ${dim("Indexed chunks:   ")}${totalChunks}`);
          console.log(`  ${dim("Sessions tracked: ")}${overview.total_sessions}`);
          console.log(`  ${dim("Messages:         ")}${overview.total_messages}`);
          console.log(`  ${dim("Tool calls:       ")}${overview.total_tool_calls}`);
          for (const [source, count] of sourceMap) {
            console.log(`    ${dim(`${source}:`)} ${count}`);
          }
        } finally {
          await provider.close();
        }
      } catch (err) {
        console.log(`\n  ${red("Could not connect to PostgreSQL")}: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Print allOk after async stats
      printAllOk();
    })();
    return; // allOk will be printed by async block
  }

  const sqliteDbPath = (backendConfig as import("./config").SqliteBackendConfig).dbPath;
  console.log(`  ${ok(fs.existsSync(sqliteDbPath))}  Database    ${dim(sqliteDbPath)}`);

  if (fs.existsSync(sqliteDbPath)) {
    try {
      const db = openDatabase({ dbPath: sqliteDbPath });
      const chunks = (db.prepare("SELECT COUNT(*) as n FROM vec_items").get() as { n: number }).n;
      const sessions = (db.prepare("SELECT COUNT(*) as n FROM sessions_meta").get() as { n: number }).n;
      const bySource = db.prepare(
        "SELECT source, COUNT(*) as n FROM sessions_meta GROUP BY source"
      ).all() as Array<{ source: string; n: number }>;
      db.close();
      const dbBytes = fs.statSync(sqliteDbPath).size;
      const dbSize = dbBytes >= 1_048_576
        ? `${(dbBytes / 1_048_576).toFixed(1)} MB`
        : `${(dbBytes / 1_024).toFixed(1)} KB`;
      console.log(`\n  ${dim("Backend:          ")}SQLite`);
      console.log(`  ${dim("DB size:          ")}${dbSize}`);
      console.log(`  ${dim("Indexed chunks:   ")}${chunks}`);
      console.log(`  ${dim("Sessions tracked: ")}${sessions}`);
      for (const row of bySource) {
        console.log(`    ${dim(`${row.source}:`)} ${row.n}`);
      }
    } catch { /* DB might be empty */ }
  }

  printAllOk();

  function printAllOk() {
    const allOk = (!openCodeInstalled || (
      fs.existsSync(getOpenCodePluginDst()) &&
      fs.existsSync(getOpenCodeSkillDst()) &&
      checkMcpConfigured()
    )) &&
      (!claudeInstalled || (
        checkClaudeMcpConfigured() &&
        checkClaudeHookInstalled() &&
        checkClaudeSkillInstalled()
      )) &&
      (!cursorInstalled || (
        checkCursorMcpConfigured() &&
        checkCursorHookInstalled() &&
        fs.existsSync(getCursorSkillDst())
      )) &&
      (!vscodeInstalled || (
        checkVscodeMcpConfigured() &&
        checkVscodeHookInstalled() &&
        checkVscodeHookLocationRegistered()
      )) &&
      (!codexInstalled || (
        checkCodexMcpConfigured() &&
        checkCodexOpenAiPassthroughConfigured() &&
        checkCodexHookInstalled() &&
        fs.existsSync(getCodexSkillDst())
      )) &&
      (!geminiInstalled || (
        checkGeminiMcpConfigured() &&
        checkGeminiHookInstalled() &&
        fs.existsSync(getGeminiSkillDst())
      )) &&
      fs.existsSync(mcpPath);

    console.log(`\n  ${allOk
      ? green("All components installed.")
      : red("Some components missing — run \"npx code-session-memory install\".")
    }\n`);
  }
}

/**
 * Reports the two things that silently break indexing under a GUI-launched
 * host: an unusable node path in the configs, and a missing API key.
 */
function printRuntimeStatus(): void {
  console.log(bold("\n  Runtime (how hooks are launched)"));

  const executables = collectConfiguredExecutables();
  if (executables.length === 0) {
    console.log(`  ${dim("○")}  Node binary  ${dim("(nothing installed yet)")}`);
  } else {
    const broken = executables.filter((entry) => !isResolvedNodePath(entry.exec));
    const distinct = [...new Set(executables.map((entry) => entry.exec))];
    console.log(`  ${ok(broken.length === 0)}  Node binary  ${dim(distinct.join(", "))}`);
    for (const entry of broken) {
      const reason = path.isAbsolute(entry.exec)
        ? "no longer exists"
        : "not an absolute path — fails when the app is launched from the GUI";
      console.log(`     ${red("!")} ${entry.label}: ${entry.exec} ${dim(`(${reason})`)}`);
    }
    if (broken.length > 0) {
      console.log(`     ${dim("Fix: re-run")} ${bold("npx code-session-memory install")}`);
    }
  }

  // Environment the hooks will see: process env is irrelevant here — what
  // matters is the snapshot, because a GUI-launched host provides nothing.
  const snapshot = loadEnvSnapshot();
  const snapshotKeys = SNAPSHOT_ENV_KEYS.filter((key) => snapshot[key]);
  const missing = REQUIRED_ENV_KEYS.filter((key) => !snapshot[key]);
  console.log(`  ${ok(missing.length === 0)}  Env snapshot ${dim(getEnvFilePath())}`);
  for (const key of snapshotKeys) {
    console.log(`     ${dim(`${key}=${maskEnvValue(key, snapshot[key])}`)}`);
  }
  for (const key of missing) {
    const inShell = process.env[key] ? " (set in this shell but not recorded)" : "";
    console.log(`     ${red("!")} ${key} missing${inShell}`);
  }
  if (missing.length > 0) {
    console.log(`     ${dim("Fix:")} ${bold(`npx code-session-memory config set-env ${missing[0]}=...`)}`);
  }

  // Hook log — the only trace of a hook that ran, since hosts discard stderr.
  const logPath = getHookLogPath();
  const recent = readHookLog(50);
  const lastRun = [...recent].reverse().find((entry) => entry.level === "info");
  const lastError = [...recent].reverse().find((entry) => entry.level === "error");
  console.log(`  ${ok(recent.length > 0)}  Hook log     ${dim(logPath)}`);
  if (lastRun) console.log(`     ${dim(`last run:   ${lastRun.timestamp} [${lastRun.source}] ${lastRun.message}`)}`);
  if (lastError) console.log(`     ${red("!")} ${dim(`last error: ${lastError.timestamp} [${lastError.source}] ${lastError.message}`)}`);
  if (recent.length === 0) {
    console.log(`     ${dim("No hook has run yet — start a session in one of the tools above.")}`);
  }
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
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
        try {
          const dir = path.dirname(p);
          if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        } catch { /* ignore */ }
      }
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
    ["Claude Code skill", () => {
      if (uninstallClaudeSkill() === "not_found") throw new Error("not found");
    }],
    ["Cursor MCP config", () => {
      if (uninstallCursorMcpConfig() === "not_found") throw new Error("not found");
    }],
    ["Cursor stop hook", () => {
      if (uninstallCursorHook() === "not_found") throw new Error("not found");
    }],
    ["Cursor skill", () => {
      if (uninstallCursorSkill() === "not_found") throw new Error("not found");
    }],
    ["VS Code MCP config", () => {
      if (uninstallVscodeMcpConfig() === "not_found") throw new Error("not found");
    }],
    ["VS Code Stop hook", () => {
      if (uninstallVscodeHook() === "not_found") throw new Error("not found");
    }],
    ["VS Code hook location", () => {
      if (uninstallVscodeHookLocation() === "not_found") throw new Error("not found");
    }],
    ["Codex MCP config", () => {
      if (uninstallCodexMcpConfig() === "not_found") throw new Error("not found");
    }],
    ["Codex notify hook", () => {
      if (uninstallCodexHook() === "not_found") throw new Error("not found");
    }],
    ["Codex skill", () => {
      if (uninstallCodexSkill() === "not_found") throw new Error("not found");
    }],
    ["Gemini CLI MCP config", () => {
      if (uninstallGeminiMcpConfig() === "not_found") throw new Error("not found");
    }],
    ["Gemini CLI AfterAgent hook", () => {
      if (uninstallGeminiHook() === "not_found") throw new Error("not found");
    }],
    ["Gemini CLI skill", () => {
      if (uninstallGeminiSkill() === "not_found") throw new Error("not found");
    }],
    ["Env snapshot", () => {
      const p = getEnvFilePath();
      if (fs.existsSync(p)) fs.unlinkSync(p);
      else throw new Error("not found");
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

async function resetDb(): Promise<void> {
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

  // Prompt for confirmation using clack (handles TTY correctly)
  const confirmed = await clack.confirm({
    message: "This will permanently delete all indexed data. Continue?",
    initialValue: false,
  });

  if (clack.isCancel(confirmed) || !confirmed) {
    clack.cancel("Aborted — database was not modified.");
    return;
  }

  fs.unlinkSync(dbPath);

  // Re-initialise an empty DB
  const db = openDatabase({ dbPath });
  db.close();

  clack.outro(`${green("Done.")} Database reset — all indexed data removed.`);
}

// ---------------------------------------------------------------------------
// config command
// ---------------------------------------------------------------------------

async function cmdConfig(args: string[]): Promise<void> {
  const { loadConfigFile, saveConfigFile, getConfigFilePath, resolveBackendConfig } = require("./config");
  const sub = args[0];

  if (sub === "set-backend") {
    const backend = args[1];
    if (backend === "postgres") {
      const urlIdx = args.indexOf("--url");
      const url = urlIdx !== -1 ? args[urlIdx + 1] : undefined;
      if (!url) {
        console.error("Usage: code-session-memory config set-backend postgres --url <connection_string>");
        process.exit(1);
      }

      // Test the connection
      process.stdout.write("Testing connection... ");
      try {
        const pg = require("pg");
        const pool = new pg.Pool({
          connectionString: url,
          ssl: args.includes("--ssl") ? { rejectUnauthorized: false } : undefined,
          max: 1,
        });
        const client = await pool.connect();
        await client.query("SELECT 1");
        client.release();
        await pool.end();
        console.log("OK");
      } catch (err: unknown) {
        console.log("FAILED");
        console.error(`Connection error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      // Create schema
      process.stdout.write("Creating schema... ");
      try {
        const { createProvider } = require("./providers");
        const provider = await createProvider({
          backend: "postgres",
          connectionString: url,
          ssl: args.includes("--ssl"),
        });
        await provider.close();
        console.log("OK");
      } catch (err: unknown) {
        console.log("FAILED");
        console.error(`Schema error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }

      // Save config
      const config = loadConfigFile();
      config.backend = "postgres";
      config.postgres = {
        url,
        ssl: args.includes("--ssl") || undefined,
      };
      saveConfigFile(config);
      console.log(`Config saved to ${getConfigFilePath()}`);
      console.log(`\nBackend set to ${bold("postgres")}. Indexers and MCP server will now use PostgreSQL.`);
      console.log(`Run ${bold("code-session-memory migrate")} to migrate existing SQLite data.`);

    } else if (backend === "sqlite") {
      const config = loadConfigFile();
      config.backend = "sqlite";
      delete config.postgres;
      saveConfigFile(config);
      console.log(`Config saved to ${getConfigFilePath()}`);
      console.log(`Backend set to ${bold("sqlite")}.`);

    } else {
      console.error('Usage: code-session-memory config set-backend <sqlite|postgres> [--url <url>]');
      process.exit(1);
    }

  } else if (sub === "set-env") {
    // Records variables for hooks launched by GUI apps, which inherit no
    // shell profile. Accepts KEY=VALUE pairs, or KEY to copy from this shell.
    const assignments = args.slice(1);
    if (assignments.length === 0) {
      console.error("Usage: code-session-memory config set-env KEY=VALUE [KEY=VALUE...]");
      process.exit(1);
    }

    const values: Record<string, string> = {};
    for (const assignment of assignments) {
      const eq = assignment.indexOf("=");
      const key = eq === -1 ? assignment : assignment.slice(0, eq);
      const value = eq === -1 ? process.env[key] : assignment.slice(eq + 1);
      if (!SNAPSHOT_ENV_KEYS.includes(key as (typeof SNAPSHOT_ENV_KEYS)[number])) {
        console.error(`Unknown variable: ${key}`);
        console.error(`Supported: ${SNAPSHOT_ENV_KEYS.join(", ")}`);
        process.exit(1);
      }
      if (!value) {
        console.error(`No value for ${key} (not given, and not set in this shell)`);
        process.exit(1);
      }
      values[key] = value;
    }

    const saved = saveEnvSnapshot(values);
    console.log(`Saved to ${getEnvFilePath()}`);
    for (const key of Object.keys(values)) {
      console.log(`  ${key}=${maskEnvValue(key, saved[key])}`);
    }
    console.log("\nRestart your editors for hooks to pick this up.");

  } else if (sub === "env") {
    const snapshot = loadEnvSnapshot();
    const keys = SNAPSHOT_ENV_KEYS.filter((key) => snapshot[key]);
    console.log(`Env snapshot: ${getEnvFilePath()}`);
    if (keys.length === 0) {
      console.log("  (empty)");
    } else {
      for (const key of keys) console.log(`  ${key}=${maskEnvValue(key, snapshot[key])}`);
    }
    const missing = REQUIRED_ENV_KEYS.filter((key) => !snapshot[key]);
    for (const key of missing) {
      console.log(`  ${red("!")} ${key} missing — hooks in GUI-launched apps will fail`);
    }

  } else if (sub === "show") {
    try {
      const config = resolveBackendConfig();
      console.log(`Backend: ${bold(config.backend)}`);
      if (config.backend === "postgres") {
        const masked = config.connectionString.replace(/:[^:@]*@/, ":***@");
        console.log(`URL: ${masked}`);
        console.log(`SSL: ${config.ssl ?? false}`);
      } else {
        console.log(`DB path: ${config.dbPath}`);
      }
      console.log(`Config file: ${getConfigFilePath()}`);
    } catch (err: unknown) {
      console.error(err instanceof Error ? err.message : String(err));
    }

  } else {
    console.log(`
${bold("config")} — Manage the database backend and the hook environment

${bold("Usage:")}
  code-session-memory config set-backend postgres --url <connection_string> [--ssl]
  code-session-memory config set-backend sqlite
  code-session-memory config show

${bold("Environment for GUI-launched apps")} — hooks started by a desktop app get no
shell profile, so the variables they need are recorded in a snapshot file:

  code-session-memory config set-env OPENAI_API_KEY=sk-...
  code-session-memory config set-env OPENAI_API_KEY        ${dim("(copy from this shell)")}
  code-session-memory config env                           ${dim("(show the snapshot)")}
`);
  }
}

// ---------------------------------------------------------------------------
// migrate command
// ---------------------------------------------------------------------------

async function cmdMigrate(args: string[]): Promise<void> {
  const { migrateSqliteToPg, discoverSqliteDbPaths } = require("./migrate/sqlite-to-pg") as typeof import("./migrate/sqlite-to-pg");

  // Parse args
  const sqlitePaths: string[] = [];
  let pgUrl: string | undefined;
  let originHost: string | undefined;
  let dryRun = false;
  let batchSize = 100;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--sqlite") {
      const val = args[++i];
      if (val) sqlitePaths.push(val);
    } else if (arg === "--pg-url") {
      pgUrl = args[++i];
    } else if (arg === "--origin") {
      originHost = args[++i];
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--batch-size") {
      const val = args[++i];
      if (val) batchSize = parseInt(val, 10);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
${bold("migrate")} — Migrate SQLite data to PostgreSQL

${bold("Usage:")}
  code-session-memory migrate                                  Auto-detect SQLite + use configured Postgres
  code-session-memory migrate --sqlite <path>                  Specify SQLite DB (repeatable)
  code-session-memory migrate --pg-url <url>                   Override Postgres URL
  code-session-memory migrate --origin <hostname>              Label source machine (default: hostname)
  code-session-memory migrate --dry-run                        Preview without writing
  code-session-memory migrate --batch-size <n>                 Rows per batch (default: 100)

${bold("Typical flow:")}
  1. code-session-memory config set-backend postgres --url postgresql://...
  2. code-session-memory migrate
`);
      return;
    }
  }

  // Auto-discover SQLite if not specified
  if (sqlitePaths.length === 0) {
    const discovered = discoverSqliteDbPaths();
    if (discovered.length === 0) {
      console.error("No SQLite databases found. Specify --sqlite <path> explicitly.");
      process.exit(1);
    }
    sqlitePaths.push(...discovered);
    console.log(`Auto-discovered SQLite DB(s): ${sqlitePaths.join(", ")}`);
  }

  // Build pg config override if --pg-url was given
  let pgConfig: import("./config").PostgresBackendConfig | undefined;
  if (pgUrl) {
    pgConfig = { backend: "postgres", connectionString: pgUrl };
  }

  console.log(dryRun ? "DRY RUN — no data will be written\n" : "");

  const report = await migrateSqliteToPg({
    sqlitePaths,
    pgConfig,
    originHost,
    dryRun,
    batchSize,
    onProgress: (ev) => {
      process.stdout.write(`\r  ${ev.phase}: ${ev.processed}/${ev.total}`);
      if (ev.processed === ev.total) process.stdout.write("\n");
    },
  });

  console.log(`\nMigration ${dryRun ? "(dry run) " : ""}complete:`);
  console.log(`  Sessions:   ${report.sessions}`);
  console.log(`  Chunks:     ${report.chunks}`);
  console.log(`  Messages:   ${report.messages}`);
  console.log(`  Tool calls: ${report.toolCalls}`);
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

function help(): void {
  console.log(`
${bold("code-session-memory")} — Shared vector memory for OpenCode, Claude Code, Cursor, VS Code, Codex, and Gemini CLI sessions

${bold("Usage:")}
  npx code-session-memory install                         Install components for detected tools
  npx code-session-memory status                          Show installation status and DB stats
  npx code-session-memory uninstall                       Remove all installed components (keeps DB)
  npx code-session-memory reset-db                        Delete all indexed data (keeps installation)
  npx code-session-memory query <text>                    Semantic search across all indexed sessions
  npx code-session-memory query <text> --hybrid           Use hybrid search (keyword + vector)
  npx code-session-memory query <text> --source <s>       Filter by source (opencode, claude-code, cursor, vscode, codex, gemini-cli)
  npx code-session-memory query <text> --limit <n>        Max results (default: 5)
  npx code-session-memory query <text> --from <date>      Results from date (e.g. 2026-02-01)
  npx code-session-memory query <text> --to <date>        Results up to date (e.g. 2026-02-20)
  npx code-session-memory sessions                        Browse sessions (tree: source → date → session)
  npx code-session-memory sessions print <id>             Print all chunks of a session to stdout
  npx code-session-memory sessions delete <id>            Delete a session from the DB
  npx code-session-memory sessions purge --days <n>       Delete sessions older than N days (interactive)
  npx code-session-memory sessions purge --days <n> --yes Delete sessions older than N days (no prompt)
  npx code-session-memory web [--port <n>]                Start the web UI (default: port 3333)
  npx code-session-memory config set-backend <backend>    Set database backend (sqlite or postgres)
  npx code-session-memory config show                     Show current backend configuration
  npx code-session-memory config set-env KEY=VALUE         Record a variable for hooks in GUI-launched apps
  npx code-session-memory config env                      Show the recorded hook environment
  npx code-session-memory migrate                         Migrate SQLite data to PostgreSQL
  npx code-session-memory backfill-analytics              Fill per-model analytics for already-indexed sessions
  npx code-session-memory help                            Show this help

${bold("Environment variables:")} ${dim("(GUI-launched apps get these from the env snapshot instead)")}
  OPENAI_API_KEY            Required for embedding generation
  OPENCODE_MEMORY_DB_PATH   Override the default SQLite DB path
  CSM_BACKEND               Override backend (sqlite or postgres)
  CSM_POSTGRES_URL          PostgreSQL connection string (when CSM_BACKEND=postgres)
  OPENCODE_CONFIG_DIR       Override the OpenCode config directory
  CLAUDE_CONFIG_DIR         Override the Claude Code config directory
  CURSOR_CONFIG_DIR         Override the Cursor config directory (~/.cursor)
  VSCODE_CONFIG_DIR         Override the VS Code config directory
  CODEX_HOME                Override the Codex home directory (~/.codex)
  GEMINI_CONFIG_DIR         Override the Gemini CLI config directory (~/.gemini)
`);
}

// ---------------------------------------------------------------------------
// backfill-analytics command
// ---------------------------------------------------------------------------

async function cmdBackfillAnalytics(args: string[]): Promise<void> {
  const sources: import("./types").SessionSource[] = [];
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--source") {
      const val = args[++i];
      if (val === "claude-code" || val === "opencode" || val === "codex") sources.push(val);
      else {
        console.error(`Unsupported source "${val}" — backfill supports claude-code, opencode and codex`);
        process.exit(1);
      }
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
${bold("backfill-analytics")} — Fill in per-model analytics (model, token usage) for already-indexed sessions

Re-reads Claude Code / Codex transcripts and the OpenCode DB and refreshes the
${bold("messages")} / ${bold("tool_calls")} analytics tables. No embeddings are generated,
so this is fast and needs no OPENAI_API_KEY. Safe to run more than once.

${bold("Usage:")}
  code-session-memory backfill-analytics                       All Claude Code + OpenCode + Codex sessions
  code-session-memory backfill-analytics --source claude-code  One source only (repeatable)
  code-session-memory backfill-analytics --dry-run             Parse and report without writing
`);
      return;
    }
  }

  const { resolveBackendConfig } = require("./config") as typeof import("./config");
  const { createProvider } = require("./providers") as typeof import("./providers");
  const { backfillAnalytics } = require("./analytics-backfill") as typeof import("./analytics-backfill");

  const provider = await createProvider(resolveBackendConfig());
  try {
    console.log(bold(`\ncode-session-memory backfill-analytics${dryRun ? " (dry run)" : ""}\n`));
    const report = await backfillAnalytics(provider, {
      sources: sources.length > 0 ? sources : undefined,
      dryRun,
      onProgress: (done, total, last) => {
        const tag = last.status === "updated" ? green("updated") : last.status === "skipped" ? dim("skipped") : red("failed ");
        const detail = last.status === "updated"
          ? dim(`${last.messagesWithModel} assistant messages with model`)
          : dim(last.reason ?? "");
        console.log(`  [${String(done).padStart(String(total).length)}/${total}] ${tag} ${last.source.padEnd(11)} ${last.sessionId} ${detail}`);
      },
    });

    console.log(`
${bold("Done.")} ${report.updated} updated, ${report.skipped} skipped, ${report.failed} failed (of ${report.total} sessions).
${report.skipped > 0 ? dim("Skipped sessions have no transcript on disk anymore (or are not Claude Code / OpenCode / Codex).") + "\n" : ""}`);
  } finally {
    await provider.close();
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Fill environment gaps from the snapshot so commands work identically when
// launched from a shell that does not export OPENAI_API_KEY. Never probes the
// login shell here — `install` does that explicitly and reports what it found.
hydrateEnv({ probeShell: false });

const cmd = process.argv[2] ?? "help";

switch (cmd) {
  case "install":   install();   break;
  case "status":    status();    break;
  case "uninstall": uninstall(); break;
  case "reset-db":
    resetDb().catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
    break;
  case "query":
    cmdQuery(process.argv.slice(3)).catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
    break;
  case "sessions":
    cmdSessions(process.argv.slice(3)).catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
    break;
  case "web": {
    const webArgs = process.argv.slice(3);
    let port = 3333;
    let host = "localhost";
    const portIdx = webArgs.indexOf("--port");
    if (portIdx !== -1 && webArgs[portIdx + 1]) {
      const p = parseInt(webArgs[portIdx + 1], 10);
      if (!isNaN(p) && p > 0) port = p;
    }
    const hostIdx = webArgs.indexOf("--host");
    if (hostIdx !== -1 && webArgs[hostIdx + 1]) {
      host = webArgs[hostIdx + 1];
    }
    const { startWebServer } = require("./web/server");
    startWebServer({ port, host }).catch((err: Error) => {
      console.error(err.message);
      process.exit(1);
    });
    break;
  }
  case "config":
    cmdConfig(process.argv.slice(3)).catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
    break;
  case "migrate":
    cmdMigrate(process.argv.slice(3)).catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
    break;
  case "backfill-analytics":
    cmdBackfillAnalytics(process.argv.slice(3)).catch((err) => {
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
