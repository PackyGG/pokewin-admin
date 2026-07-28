import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as mainSchema from "./db-schema/main/schema";
import { readDbEnv, type DbEnv } from "./db-env";

export type MainDrizzleDb = NodePgDatabase<typeof mainSchema>;

const globalForMainDb = globalThis as unknown as {
  mainReadDbPools: Map<DbEnv, Pool> | undefined;
  mainReadDrizzleClients: Map<DbEnv, MainDrizzleDb> | undefined;
  mainPrimaryDbPools: Map<DbEnv, Pool> | undefined;
  mainPrimaryDrizzleClients: Map<DbEnv, MainDrizzleDb> | undefined;
};

type MainDbAccess = "read" | "primary";

function mirrorConnectionString(connectionString: string): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("The configured MAIN mirror URL is invalid");
  }
  if (
    url.searchParams.get("sslmode") === "require" &&
    !url.searchParams.has("uselibpqcompat")
  ) {
    // node-postgres 8 aliases sslmode=require to verify-full. Our mirror URLs
    // intentionally use the standard libpq meaning: encrypted transport.
    url.searchParams.set("uselibpqcompat", "true");
  }
  return url.toString();
}

function createPool(
  connectionString: string | undefined,
  env: DbEnv,
  access: MainDbAccess,
): Pool {
  if (!connectionString) {
    throw new Error(
      `${env} ${access} PostgreSQL connection URL is not configured`,
    );
  }

  const isReadMirror = access === "read";
  const pool = new Pool({
    connectionString: isReadMirror
      ? mirrorConnectionString(connectionString)
      : connectionString,
    application_name: `pokewin-admin-main-${env}-${access}`,
    min: 0,
    // The production mirror role is capped at 30 sessions and is shared with
    // Antifraud. A wide per-instance pool multiplied across Vercel isolates
    // exhausted that role. Two slots still match the app's bounded read
    // concurrency while preserving headroom across warm serverless instances.
    // Primary pools remain at three for mutation flows and consistency reads.
    max: isReadMirror ? 2 : 3,
    idleTimeoutMillis: isReadMirror ? 5_000 : 10_000,
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
    // Defense in depth: even if a caller accidentally sends mutation SQL
    // through a mirror client, PostgreSQL rejects it before state can change.
    ...(isReadMirror
      ? { options: "-c default_transaction_read_only=on -c TimeZone=UTC" }
      : {}),
  });
  pool.on("error", (error) => {
    console.error(`[db:${env}:${access}] Pool error:`, error.message);
  });
  return pool;
}

const readPools: Map<DbEnv, Pool> =
  globalForMainDb.mainReadDbPools ?? new Map<DbEnv, Pool>();
const readClients: Map<DbEnv, MainDrizzleDb> =
  globalForMainDb.mainReadDrizzleClients ?? new Map<DbEnv, MainDrizzleDb>();
const primaryPools: Map<DbEnv, Pool> =
  globalForMainDb.mainPrimaryDbPools ?? new Map<DbEnv, Pool>();
const primaryClients: Map<DbEnv, MainDrizzleDb> =
  globalForMainDb.mainPrimaryDrizzleClients ?? new Map<DbEnv, MainDrizzleDb>();

if (process.env.NODE_ENV !== "production") {
  globalForMainDb.mainReadDbPools = readPools;
  globalForMainDb.mainReadDrizzleClients = readClients;
  globalForMainDb.mainPrimaryDbPools = primaryPools;
  globalForMainDb.mainPrimaryDrizzleClients = primaryClients;
}

function readMirrorUrl(env: DbEnv): string {
  const url =
    env === "dev"
      ? process.env.MIRROR_DEV_DB?.trim()
      : process.env.MIRROR_PRODUCTION_DB?.trim();
  if (!url) {
    throw new Error(
      env === "dev"
        ? "MIRROR_DEV_DB is not configured on this server"
        : "MIRROR_PRODUCTION_DB is not configured on this server",
    );
  }
  return url;
}

function primaryUrl(env: DbEnv): string {
  const prodUrl = (
    process.env.DATABASE_URL_POOLED ?? process.env.DATABASE_URL
  )?.trim();
  const url = env === "dev" ? process.env.DEV_DATABASE_URL?.trim() : prodUrl;
  if (!url) {
    throw new Error(
      env === "dev"
        ? "DEV_DATABASE_URL is not configured on this server"
        : "DATABASE_URL_POOLED or DATABASE_URL is not configured on this server",
    );
  }
  return url;
}

function getPool(env: DbEnv, access: MainDbAccess): Pool {
  const pools = access === "read" ? readPools : primaryPools;
  const existing = pools.get(env);
  if (existing) return existing;

  const pool = createPool(
    access === "read" ? readMirrorUrl(env) : primaryUrl(env),
    env,
    access,
  );
  pools.set(env, pool);
  return pool;
}

function getDrizzleClient(env: DbEnv, access: MainDbAccess): MainDrizzleDb {
  const clients = access === "read" ? readClients : primaryClients;
  const existing = clients.get(env);
  if (existing) return existing;

  const client = drizzle(getPool(env, access), { schema: mainSchema });
  clients.set(env, client);
  return client;
}

/** Read-only MAIN mirror access pinned to production. */
export function getProdReadDrizzleDb(): MainDrizzleDb {
  return getDrizzleClient("prod", "read");
}

/** Read-only MAIN mirror access pinned to development. */
export function getDevReadDrizzleDb(): MainDrizzleDb {
  return getDrizzleClient("dev", "read");
}

/** Canonical request-scoped MAIN read respecting the admin DB toggle. */
export async function getReadDrizzleDb(): Promise<MainDrizzleDb> {
  return getDrizzleClient(await readDbEnv(), "read");
}

/** Sync MAIN mirror read for cache callbacks whose environment is already keyed. */
export function readDrizzleForEnv(env: DbEnv): MainDrizzleDb {
  return getDrizzleClient(env, "read");
}

/** Primary MAIN access pinned to production for mutation flows. */
export function getProdPrimaryDrizzleDb(): MainDrizzleDb {
  return getDrizzleClient("prod", "primary");
}

/** Primary MAIN access pinned to development for mutation flows. */
export function getDevPrimaryDrizzleDb(): MainDrizzleDb {
  return getDrizzleClient("dev", "primary");
}

/** Request-scoped primary MAIN access for writes and consistency reads. */
export async function getPrimaryDrizzleDb(): Promise<MainDrizzleDb> {
  return getDrizzleClient(await readDbEnv(), "primary");
}

/** Sync primary MAIN access when the environment is already resolved. */
export function primaryDrizzleForEnv(env: DbEnv): MainDrizzleDb {
  return getDrizzleClient(env, "primary");
}
