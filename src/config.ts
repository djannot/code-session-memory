import fs from "fs";
import path from "path";
import os from "os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppConfig {
  postHookCommand?: string;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Returns the path to the config file.
 * Respects OPENCODE_MEMORY_CONFIG_PATH env var, otherwise falls back to
 * ~/.local/share/code-session-memory/config.json (same directory as the DB).
 */
export function getConfigPath(): string {
  const envPath = process.env.OPENCODE_MEMORY_CONFIG_PATH;
  if (envPath) return envPath.replace(/^~/, os.homedir());
  return path.join(os.homedir(), ".local", "share", "code-session-memory", "config.json");
}

// ---------------------------------------------------------------------------
// Load / Save
// ---------------------------------------------------------------------------

export function loadConfig(): AppConfig {
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as AppConfig;
  } catch {
    return {};
  }
}

export function saveConfig(config: AppConfig): void {
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}
