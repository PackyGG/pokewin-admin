import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as mainSchema from "./db-schema/main/schema";
import { readDbEnv, type DbEnv } from "./db-env";
import { withMainReadSlot } from "./main-read-limiter";

/**
 * Mirror pool size. Kept as a named constant because the read admission
 * limiter MUST be sized to exactly this number — a limiter larger than the
 * pool reintroduces pool-queue waiting, and a smaller one throttles below
 * capacity.
 */
const MIRROR_POOL_MAX = 2;

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
    // Antifraud. Two slots prevent one slow read from serializing every query
    // on a page, while remaining far below the old eight-session fan-out.
    // Vercel can freeze an isolate before node-postgres runs its idle timer.
    // Retire mirror clients after every checkout so a completed request cannot
    // retain one of the shared role's 30 sessions indefinitely. A previous
    // attempt to reclaim them with PostgreSQL idle_session_timeout made thawed
    // isolates reuse server-killed sockets (57P05); maxUses=1 closes them from
    // the client as part of release instead. Primary pools remain at three.
    max: isReadMirror ? MIRROR_POOL_MAX : 3,
    maxUses: isReadMirror ? 1 : Infinity,
    idleTimeoutMillis: isReadMirror ? 1_000 : 10_000,
    // Mirror reads are wrapped by 15s UI fallbacks on the busiest pages. Do
    // not leave their pool waiters alive for another 20s after the caller has
    // already degraded: during mirror connection loss/capacity exhaustion,
    // those orphaned waiters occupy the two pool slots and turn refreshes into
    // a connection stampede. Primary operations retain the longer budget;
    // only read-only mirror acquisition fails fast here.
    connectionTimeoutMillis: isReadMirror ? 10_000 : 35_000,
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
    // Do not set idle_session_timeout here. Mirror clients are retired on
    // release above; a server timeout instead leaves a frozen isolate holding
    // a stale socket that fails with PostgreSQL 57P05 after thaw.
    // work_mem: the mirror server runs the PostgreSQL default of 4MB, which
    // spilled ~98GB of sort/hash temp files and made analytics reads thrash
    // disk instead of finishing in memory. 32MB per sort node across at most
    // 30 role sessions stays well inside the host's memory while letting the
    // dashboard aggregates complete without spilling.
    // random_page_cost: the default of 4 models spinning disks; the mirror is
    // SSD-backed, and 1.1 keeps the planner on the covering indexes instead
    // of bailing to sequential scans it can't afford on this box.
    ...(isReadMirror
      ? {
          options:
            "-c default_transaction_read_only=on -c TimeZone=UTC -c work_mem=32MB -c random_page_cost=1.1",
        }
      : {}),
  });
  pool.on("error", (error) => {
    console.error(`[db:${env}:${access}] Pool error:`, error.message);
  });
  return isReadMirror ? withReadAdmissionControl(pool, env) : pool;
}

/**
 * Route every mirror acquisition through a process-wide semaphore sized to the
 * pool.
 *
 * Without this, excess readers queue INSIDE node-postgres, where
 * `connectionTimeoutMillis` (10s) is applied to the queue wait. Since
 * `statement_timeout` is 30s, one slow query can hold a slot three times longer
 * than a queued reader will wait, so the queued read rejects with
 * `timeout exceeded when trying to connect`. That is not a QueryTimeoutError,
 * so `safeQuery` reports it as a hard failure and the tile renders "Couldn't
 * load this section" — on a different tile every reload, because it is a race.
 *
 * Admitting at most `max` readers keeps the pool's own queue empty, so the
 * connect timeout again means "could not connect" rather than "pool was busy".
 * Callers remain bounded by `safeQuery`/`withTimeout` above and
 * `statement_timeout` below, so a genuinely slow read still degrades its own
 * tile — it just no longer takes healthy siblings down with it.
 */
function withReadAdmissionControl(pool: Pool, env: DbEnv): Pool {
  const key = `main:${env}:read`;
  const permits = MIRROR_POOL_MAX;
  const nativeQuery = pool.query.bind(pool);
  const nativeConnect = pool.connect.bind(pool);

  // `query` is what Drizzle uses for every non-transactional statement.
  Reflect.set(pool, "query", (...args: unknown[]) =>
    withMainReadSlot(key, permits, () =>
      (nativeQuery as (...a: unknown[]) => Promise<unknown>)(...args),
    ),
  );

  // `connect` backs `db.transaction(...)`. The permit must span the WHOLE
  // checkout, so it is released by `release()` rather than on acquisition —
  // otherwise a transaction would hold a pool slot without holding a permit.
  Reflect.set(pool, "connect", async (...args: unknown[]) => {
    let releasePermit: (() => void) | undefined;
    await new Promise<void>((admitted) => {
      void withMainReadSlot(key, permits, () => {
        admitted();
        return new Promise<void>((done) => {
          releasePermit = done;
        });
      });
    });
    try {
      const client = (await (
        nativeConnect as (...a: unknown[]) => Promise<{ release: unknown }>
      )(...args)) as { release: (...a: unknown[]) => unknown };
      const nativeRelease = client.release.bind(client);
      let released = false;
      client.release = (...releaseArgs: unknown[]) => {
        if (released) return undefined;
        released = true;
        try {
          return nativeRelease(...releaseArgs);
        } finally {
          releasePermit?.();
        }
      };
      return client;
    } catch (error) {
      // Never leak the permit when the checkout itself fails.
      releasePermit?.();
      throw error;
    }
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
