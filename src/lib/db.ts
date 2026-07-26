import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as mainSchema from "./db-schema/main/schema";
import { readDbEnv, type DbEnv } from "./db-env";

export type MainDrizzleDb = NodePgDatabase<typeof mainSchema>;

const globalForMainDb = globalThis as unknown as {
  mainDbPools: Map<DbEnv, Pool> | undefined;
  mainDrizzleClients: Map<DbEnv, MainDrizzleDb> | undefined;
};

function createPool(connectionString: string | undefined, label: string): Pool {
  if (!connectionString) {
    throw new Error(`${label} PostgreSQL connection URL is not configured`);
  }

  const pool = new Pool({
    connectionString,
    application_name: `pokewin-admin-main-${label}`,
    min: 0,
    // MAIN is shared with the game backend. Keep each serverless instance
    // deliberately small so concurrent warm instances cannot exhaust it.
    max: 3,
    idleTimeoutMillis: 10_000,
    // A queued read must be allowed to outlive the longest statement already
    // occupying a slot. The old 10s acquire budget guaranteed false pool
    // failures while valid 30s statements were still running.
    connectionTimeoutMillis: 35_000,
    // App-level Promise timeouts cannot cancel PostgreSQL work. This server-side
    // backstop releases the pool slot if a pathological query runs away.
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 30_000,
    maxLifetimeSeconds: 600,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
    allowExitOnIdle: true,
  });
  pool.on("error", (error) => {
    console.error(`[db:${label}] Pool error:`, error.message);
  });
  return pool;
}

const pools: Map<DbEnv, Pool> =
  globalForMainDb.mainDbPools ?? new Map<DbEnv, Pool>();
const clients: Map<DbEnv, MainDrizzleDb> =
  globalForMainDb.mainDrizzleClients ?? new Map<DbEnv, MainDrizzleDb>();

if (process.env.NODE_ENV !== "production") {
  globalForMainDb.mainDbPools = pools;
  globalForMainDb.mainDrizzleClients = clients;
}

function getPool(env: DbEnv): Pool {
  const existing = pools.get(env);
  if (existing) return existing;

  const prodUrl = (
    process.env.DATABASE_URL_POOLED ?? process.env.DATABASE_URL
  )?.trim();
  const url = env === "dev" ? process.env.DEV_DATABASE_URL?.trim() : prodUrl;
  if (env === "dev" && !url) {
    throw new Error("DEV_DATABASE_URL is not configured on this server");
  }
  const pool = createPool(url, env);
  pools.set(env, pool);
  return pool;
}

function getDrizzleClient(env: DbEnv): MainDrizzleDb {
  const existing = clients.get(env);
  if (existing) return existing;

  const client = drizzle(getPool(env), { schema: mainSchema });
  clients.set(env, client);
  return client;
}

/** Read-only MAIN access pinned to production. */
export function getProdDrizzleDb(): MainDrizzleDb {
  return getDrizzleClient("prod");
}

/** Read-only MAIN access pinned to development. */
export function getDevDrizzleDb(): MainDrizzleDb {
  if (!process.env.DEV_DATABASE_URL?.trim()) {
    throw new Error("DEV_DATABASE_URL is not configured on this server");
  }
  return getDrizzleClient("dev");
}

/** Canonical request-scoped MAIN access respecting the admin DB toggle. */
export async function getDrizzleDb(): Promise<MainDrizzleDb> {
  return getDrizzleClient(await readDbEnv());
}

/** Sync MAIN access for cache callbacks whose environment is already keyed. */
export function drizzleForEnv(env: DbEnv): MainDrizzleDb {
  return getDrizzleClient(env);
}
