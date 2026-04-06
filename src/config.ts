import path from "path";
import os from "os";
import fs from "fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BackendType = "sqlite" | "postgres";

export interface SqliteBackendConfig {
  backend: "sqlite";
  dbPath: string;
  embeddingDimension?: number;
}

export interface PostgresBackendConfig {
  backend: "postgres";
  /** Full connection string, e.g. postgresql://user:pass@host:5432/dbname */
  connectionString: string;
  ssl?: boolean;
  embeddingDimension?: number;
  /** Max connections in the pool (default 5) */
  poolSize?: number;
}

export type DatabaseBackendConfig = SqliteBackendConfig | PostgresBackendConfig;

/** Shape of the config file on disk. */
export interface ConfigFile {
  backend?: BackendType;
  postgres?: {
    url?: string;
    ssl?: boolean;
    poolSize?: number;
  };
  embeddingDimension?: number;
}

// ---------------------------------------------------------------------------
// Config file path
// ---------------------------------------------------------------------------

export function getConfigDir(): string {
  return path.join(os.homedir(), ".config", "code-session-memory");
}

export function getConfigFilePath(): string {
  return path.join(getConfigDir(), "config.json");
}

// ---------------------------------------------------------------------------
// Config file I/O
// ---------------------------------------------------------------------------

export function loadConfigFile(): ConfigFile {
  const configPath = getConfigFilePath();
  try {
    const raw = fs.readFileSync(configPath, "utf8").trim();
    if (!raw) return {};
    return JSON.parse(raw) as ConfigFile;
  } catch {
    return {};
  }
}

export function saveConfigFile(config: ConfigFile): void {
  const dir = getConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getConfigFilePath(), JSON.stringify(config, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Default SQLite path (re-exported from database.ts logic)
// ---------------------------------------------------------------------------

function defaultSqliteDbPath(): string {
  const envPath = process.env.OPENCODE_MEMORY_DB_PATH;
  if (envPath) return envPath.replace(/^~/, os.homedir());
  return path.join(os.homedir(), ".local", "share", "code-session-memory", "sessions.db");
}

// ---------------------------------------------------------------------------
// Resolve backend config
// ---------------------------------------------------------------------------

/**
 * Resolves the active backend configuration.
 *
 * Priority:
 *   1. Environment variables (CSM_BACKEND + CSM_POSTGRES_URL)
 *   2. Config file (~/.config/code-session-memory/config.json)
 *   3. Default: SQLite at the standard path
 */
export function resolveBackendConfig(overrides?: {
  dbPath?: string;
  embeddingDimension?: number;
}): DatabaseBackendConfig {
  // 1. Environment variables take top priority
  const envBackend = process.env.CSM_BACKEND as BackendType | undefined;
  const envPgUrl = process.env.CSM_POSTGRES_URL;

  if (envBackend === "postgres" || (!envBackend && envPgUrl)) {
    if (!envPgUrl) {
      throw new Error("CSM_BACKEND=postgres but CSM_POSTGRES_URL is not set");
    }
    return {
      backend: "postgres",
      connectionString: envPgUrl,
      ssl: process.env.CSM_POSTGRES_SSL === "true",
      embeddingDimension: overrides?.embeddingDimension,
    };
  }

  if (envBackend === "sqlite") {
    // Explicit SQLite — skip config file entirely
    return {
      backend: "sqlite",
      dbPath: overrides?.dbPath ?? defaultSqliteDbPath(),
      embeddingDimension: overrides?.embeddingDimension,
    };
  }

  if (envBackend === undefined) {
    // 2. Check config file
    const config = loadConfigFile();

    if (config.backend === "postgres") {
      if (!config.postgres?.url) {
        throw new Error("Config file sets backend=postgres but postgres.url is missing");
      }
      return {
        backend: "postgres",
        connectionString: config.postgres.url,
        ssl: config.postgres.ssl,
        embeddingDimension: overrides?.embeddingDimension ?? config.embeddingDimension,
        poolSize: config.postgres.poolSize,
      };
    }

    // 3. Default: SQLite
    return {
      backend: "sqlite",
      dbPath: overrides?.dbPath ?? defaultSqliteDbPath(),
      embeddingDimension: overrides?.embeddingDimension ?? config.embeddingDimension,
    };
  }

  // Unknown backend in env
  throw new Error(`Unknown CSM_BACKEND value: ${envBackend}`);
}
