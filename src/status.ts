/**
 * Shared status helpers — used by both CLI and web server.
 *
 * Extracts tool-detection, installation-check, and DB-stats logic from cli.ts
 * so it can be reused across interfaces.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { parse as parseToml } from "smol-toml";
import { resolveDbPath, openDatabase } from "./database";
import type { SessionSource } from "./types";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function getOpenCodeConfigDir(): string {
  return process.env.OPENCODE_CONFIG_DIR || path.join(os.homedir(), ".config", "opencode");
}

function getClaudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function getClaudeUserConfigPath(): string {
  return path.join(path.dirname(getClaudeConfigDir()), ".claude.json");
}

function getClaudeSettingsPath(): string {
  return path.join(getClaudeConfigDir(), "settings.json");
}

function getClaudeMdPath(): string {
  return path.join(getClaudeConfigDir(), "CLAUDE.md");
}

function getClaudeSkillDst(): string {
  return path.join(getClaudeConfigDir(), "skills", "code-session-memory", "SKILL.md");
}

function getCursorConfigDir(): string {
  return process.env.CURSOR_CONFIG_DIR || path.join(os.homedir(), ".cursor");
}

function getCursorMcpConfigPath(): string {
  return path.join(getCursorConfigDir(), "mcp.json");
}

function getCursorHooksPath(): string {
  return path.join(getCursorConfigDir(), "hooks.json");
}

function getCursorSkillDst(): string {
  return path.join(getCursorConfigDir(), "skills", "code-session-memory", "SKILL.md");
}

function getVscodeConfigDir(): string {
  if (process.env.VSCODE_CONFIG_DIR) return process.env.VSCODE_CONFIG_DIR;
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Code", "User");
  }
  return path.join(os.homedir(), ".config", "Code", "User");
}

function getVscodeMcpConfigPath(): string {
  return path.join(getVscodeConfigDir(), "mcp.json");
}

function getVscodeSettingsPath(): string {
  return path.join(getVscodeConfigDir(), "settings.json");
}

function getVscodeHooksPath(): string {
  return path.join(getVscodeConfigDir(), "hooks", "code-session-memory.json");
}

function getVscodeHooksPathTilde(): string {
  const hooksPath = getVscodeHooksPath();
  const home = os.homedir();
  if (hooksPath.startsWith(home + path.sep)) {
    return "~" + hooksPath.slice(home.length);
  }
  return hooksPath;
}

function getCodexConfigDir(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function getCodexConfigPath(): string {
  return path.join(getCodexConfigDir(), "config.toml");
}

function getCodexSkillDst(): string {
  return path.join(getCodexConfigDir(), "skills", "code-session-memory", "SKILL.md");
}

function getGeminiConfigDir(): string {
  return process.env.GEMINI_CONFIG_DIR || path.join(os.homedir(), ".gemini");
}

function getGeminiSettingsPath(): string {
  return path.join(getGeminiConfigDir(), "settings.json");
}

function getGeminiSkillDst(): string {
  return path.join(getGeminiConfigDir(), "skills", "code-session-memory", "SKILL.md");
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

function getPackageRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

function getMcpServerPath(): string {
  return path.join(getPackageRoot(), "dist", "mcp", "index.js");
}

// ---------------------------------------------------------------------------
// JSONC parser (for VS Code settings)
// ---------------------------------------------------------------------------

function parseJsonc(text: string): unknown {
  const stripped = text
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

// ---------------------------------------------------------------------------
// Tool detection
// ---------------------------------------------------------------------------

export function isOpenCodeInstalled(): boolean {
  return fs.existsSync(getOpenCodeConfigDir());
}

export function isClaudeCodeInstalled(): boolean {
  return fs.existsSync(getClaudeConfigDir());
}

export function isCursorInstalled(): boolean {
  return fs.existsSync(getCursorConfigDir());
}

export function isVscodeInstalled(): boolean {
  return fs.existsSync(getVscodeConfigDir());
}

export function isCodexInstalled(): boolean {
  return fs.existsSync(getCodexConfigDir());
}

export function isGeminiInstalled(): boolean {
  return fs.existsSync(getGeminiConfigDir());
}

// ---------------------------------------------------------------------------
// Check functions
// ---------------------------------------------------------------------------

export function checkOpenCodeMcpConfigured(): boolean {
  const configPath = getGlobalOpenCodeConfigPath();
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    return !!(cfg.mcp && typeof cfg.mcp === "object" && "code-session-memory" in (cfg.mcp as object));
  } catch { return false; }
}

export function checkClaudeMcpConfigured(): boolean {
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

export function checkClaudeHookInstalled(): boolean {
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

export function checkClaudeMdInstalled(): boolean {
  const mdPath = getClaudeMdPath();
  if (!fs.existsSync(mdPath)) return false;
  return fs.readFileSync(mdPath, "utf8").includes("<!-- code-session-memory -->");
}

export function checkCursorMcpConfigured(): boolean {
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

export function checkCursorHookInstalled(): boolean {
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

export function checkVscodeMcpConfigured(): boolean {
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

export function checkVscodeHookInstalled(): boolean {
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

export function checkVscodeHookLocationRegistered(): boolean {
  const settingsPath = getVscodeSettingsPath();
  try {
    const settings = parseJsonc(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const hookLocations = settings["chat.hookFilesLocations"] as Record<string, boolean> | undefined;
    if (!hookLocations) return false;
    return hookLocations[getVscodeHooksPathTilde()] === true ||
      hookLocations[getVscodeHooksPath()] === true;
  } catch { return false; }
}

export function checkCodexMcpConfigured(): boolean {
  const configPath = getCodexConfigPath();
  try {
    const config = parseToml(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const mcpServers = config.mcp_servers as Record<string, unknown> | undefined;
    return !!(mcpServers && Object.prototype.hasOwnProperty.call(mcpServers, "code-session-memory"));
  } catch {
    return false;
  }
}

export function checkCodexOpenAiPassthroughConfigured(): boolean {
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

export function checkCodexHookInstalled(): boolean {
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

export function checkGeminiMcpConfigured(): boolean {
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

export function checkGeminiHookInstalled(): boolean {
  const settingsPath = getGeminiSettingsPath();
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const hooks = settings.hooks as Record<string, unknown> | undefined;
    const afterAgent = hooks?.AfterAgent;
    if (!Array.isArray(afterAgent)) return false;
    return afterAgent.some((entry: unknown) => {
      if (!entry || typeof entry !== "object") return false;
      const group = entry as Record<string, unknown>;
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

// ---------------------------------------------------------------------------
// Aggregated status
// ---------------------------------------------------------------------------

export interface ToolStatus {
  installed: boolean;
  components: Array<{ name: string; ok: boolean; path: string }>;
}

export interface StatusResult {
  dbPath: string;
  dbExists: boolean;
  dbSizeBytes: number;
  totalSessions: number;
  totalChunks: number;
  totalMessages: number;
  totalToolCalls: number;
  topTools: Array<{ tool_name: string; call_count: number }>;
  sessionsBySource: Array<{ source: string; count: number }>;
  tools: Record<string, ToolStatus>;
  allOk: boolean;
}

export function getStatus(): StatusResult {
  const dbPath = resolveDbPath();
  const mcpPath = getMcpServerPath();
  const dbExists = fs.existsSync(dbPath);

  let dbSizeBytes = 0;
  let totalSessions = 0;
  let totalChunks = 0;
  let totalMessages = 0;
  let totalToolCalls = 0;
  let topTools: Array<{ tool_name: string; call_count: number }> = [];
  let sessionsBySource: Array<{ source: string; count: number }> = [];

  if (dbExists) {
    try {
      dbSizeBytes = fs.statSync(dbPath).size;
      const db = openDatabase({ dbPath });
      totalChunks = (db.prepare("SELECT COUNT(*) as n FROM vec_items").get() as { n: number }).n;
      totalSessions = (db.prepare("SELECT COUNT(*) as n FROM sessions_meta").get() as { n: number }).n;
      sessionsBySource = (db.prepare(
        "SELECT source, COUNT(*) as n FROM sessions_meta GROUP BY source"
      ).all() as Array<{ source: string; n: number }>).map(r => ({ source: r.source, count: r.n }));

      // Analytics table stats (may not exist in older DBs — catch silently)
      try {
        totalMessages = (db.prepare("SELECT COUNT(*) as n FROM messages").get() as { n: number }).n;
        totalToolCalls = (db.prepare("SELECT COUNT(*) as n FROM tool_calls").get() as { n: number }).n;
        topTools = db.prepare(
          "SELECT tool_name, COUNT(*) as call_count FROM tool_calls GROUP BY tool_name ORDER BY call_count DESC LIMIT 5"
        ).all() as Array<{ tool_name: string; call_count: number }>;
      } catch { /* tables may not exist yet */ }

      db.close();
    } catch { /* DB might be empty or broken */ }
  }

  const tools: Record<string, ToolStatus> = {};

  // OpenCode
  const ocInstalled = isOpenCodeInstalled();
  tools.opencode = {
    installed: ocInstalled,
    components: ocInstalled ? [
      { name: "Plugin", ok: fs.existsSync(getOpenCodePluginDst()), path: getOpenCodePluginDst() },
      { name: "Skill", ok: fs.existsSync(getOpenCodeSkillDst()), path: getOpenCodeSkillDst() },
      { name: "MCP config", ok: checkOpenCodeMcpConfigured(), path: getGlobalOpenCodeConfigPath() },
    ] : [],
  };

  // Claude Code
  const ccInstalled = isClaudeCodeInstalled();
  tools["claude-code"] = {
    installed: ccInstalled,
    components: ccInstalled ? [
      { name: "MCP config", ok: checkClaudeMcpConfigured(), path: getClaudeUserConfigPath() },
      { name: "Stop hook", ok: checkClaudeHookInstalled(), path: getClaudeSettingsPath() },
      { name: "Skill", ok: fs.existsSync(getClaudeSkillDst()), path: getClaudeSkillDst() },
    ] : [],
  };

  // Cursor
  const curInstalled = isCursorInstalled();
  tools.cursor = {
    installed: curInstalled,
    components: curInstalled ? [
      { name: "MCP config", ok: checkCursorMcpConfigured(), path: getCursorMcpConfigPath() },
      { name: "Stop hook", ok: checkCursorHookInstalled(), path: getCursorHooksPath() },
      { name: "Skill", ok: fs.existsSync(getCursorSkillDst()), path: getCursorSkillDst() },
    ] : [],
  };

  // VS Code
  const vsInstalled = isVscodeInstalled();
  tools.vscode = {
    installed: vsInstalled,
    components: vsInstalled ? [
      { name: "MCP config", ok: checkVscodeMcpConfigured(), path: getVscodeMcpConfigPath() },
      { name: "Stop hook", ok: checkVscodeHookInstalled(), path: getVscodeHooksPath() },
      { name: "Hook location", ok: checkVscodeHookLocationRegistered(), path: getVscodeSettingsPath() },
    ] : [],
  };

  // Codex
  const cxInstalled = isCodexInstalled();
  tools.codex = {
    installed: cxInstalled,
    components: cxInstalled ? [
      { name: "MCP config", ok: checkCodexMcpConfigured(), path: getCodexConfigPath() },
      { name: "OPENAI_KEY", ok: checkCodexOpenAiPassthroughConfigured(), path: getCodexConfigPath() },
      { name: "Notify hook", ok: checkCodexHookInstalled(), path: getCodexConfigPath() },
      { name: "Skill", ok: fs.existsSync(getCodexSkillDst()), path: getCodexSkillDst() },
    ] : [],
  };

  // Gemini CLI
  const gmInstalled = isGeminiInstalled();
  tools["gemini-cli"] = {
    installed: gmInstalled,
    components: gmInstalled ? [
      { name: "MCP config", ok: checkGeminiMcpConfigured(), path: getGeminiSettingsPath() },
      { name: "AfterAgent hook", ok: checkGeminiHookInstalled(), path: getGeminiSettingsPath() },
      { name: "Skill", ok: fs.existsSync(getGeminiSkillDst()), path: getGeminiSkillDst() },
    ] : [],
  };

  // Check shared components
  const mcpOk = fs.existsSync(mcpPath);

  // allOk: all installed tools have all components OK, plus shared components
  const allOk = Object.values(tools).every(t =>
    !t.installed || t.components.every(c => c.ok)
  ) && mcpOk && dbExists;

  return {
    dbPath,
    dbExists,
    dbSizeBytes,
    totalSessions,
    totalChunks,
    totalMessages,
    totalToolCalls,
    topTools,
    sessionsBySource,
    tools,
    allOk,
  };
}
