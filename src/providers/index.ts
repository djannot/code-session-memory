import type { DatabaseBackendConfig } from "../config";
import type { DatabaseProvider } from "./types";
import { SqliteDatabaseProvider } from "./sqlite-provider";

/**
 * Creates a DatabaseProvider from the given backend config.
 * For Postgres, the provider is initialized asynchronously (schema creation, pool setup).
 */
export async function createProvider(config: DatabaseBackendConfig): Promise<DatabaseProvider> {
  if (config.backend === "sqlite") {
    return new SqliteDatabaseProvider(config);
  }

  if (config.backend === "postgres") {
    // Lazy-load to avoid requiring pg when using sqlite
    const { PgDatabaseProvider } = await import("./pg-provider");
    const provider = new PgDatabaseProvider(config);
    await provider.initialize();
    return provider;
  }

  throw new Error(`Unknown backend: ${(config as { backend: string }).backend}`);
}

export type { DatabaseProvider } from "./types";
export type { QueryFilters } from "./types";
