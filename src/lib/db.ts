import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";

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
 * Hard ceiling on how long one checkout may hold its permit. A client still
 * unreleased after this long is treated as a leak (a caller that forgot
 * `release()`, or an isolate frozen mid-request). Returning the permit anyway
 * keeps a leak from permanently shrinking — and with only two permits,
 * deadlocking — every MAIN read in the isolate. The client itself is left
 * alone; the pool's own lifetime/idle timers reclaim it.
 *
 * It MUST stay ABOVE the longest SANCTIONED hold. Firing on a healthy-but-slow
 * reader is not a safe no-op: it returns a permit whose POOL SLOT is still
 * occupied, so the limiter admits a third reader into a two-slot pool, that
 * reader queues inside node-postgres, and `connectionTimeoutMillis` rejects it
 * with `timeout exceeded when trying to connect` — precisely the tile failure
 * admission control exists to prevent.
 *
 * Longest sanctioned hold today, and why 60s was too low: `queryRowsInTimeboxedTx`
 * (`src/lib/drizzle-query.ts`) runs a whole multi-statement transaction on ONE
 * checkout with `statement_timeout` raised per statement via `SET LOCAL`. Its
 * widest user is the creator P&L transaction — 3 statements ×
 * `CREATOR_PNL_STATEMENT_TIMEOUT_MS` (55s, `src/lib/queries/creators-pnl.ts`)
 * = 165s of legitimate hold. 180s covers that plus the BEGIN / SET / COMMIT
 * round trips. The number is written out rather than imported because
 * `creators-pnl.ts` reaches this module through `drizzle-query.ts`; a guardrail
 * (`scripts/__fixtures__/wave2-mirror-permit-budget.test.ts`) pins the
 * relationship instead, so raising a per-statement budget or adding a statement
 * to such a transaction fails the gate here rather than in production.
 */
const READ_PERMIT_WATCHDOG_MS = 180_000;

type ConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  done: PoolClient["release"],
) => void;

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
 *
 * ONLY `connect` is wrapped, and that is deliberate. `Pool.prototype.query`
 * is implemented as `this.connect((err, client) => client.query(...))`, so
 * every read — plain statement and transaction alike — passes through here
 * exactly once. Wrapping `query` as well (as this did until 2026-08-12) made a
 * statement hold one permit while its OWN internal connect waited for a second:
 * with `permits === pool max`, two concurrent reads consumed both permits and
 * then waited forever for a permit only they could release. That deadlocked
 * every MAIN read in the isolate until it was recycled — the dashboard's KPI
 * tiles blanked with "timeout exceeded when trying to connect" while the mirror
 * itself was answering in milliseconds.
 */
export function withReadAdmissionControl(pool: Pool, env: DbEnv): Pool {
  const key = `main:${env}:read`;
  const permits = MIRROR_POOL_MAX;
  const nativeConnect = pool.connect.bind(pool) as () => Promise<PoolClient>;

  // The permit must span the WHOLE checkout, so it is returned by `release()`
  // rather than on acquisition — otherwise a caller would hold a pool slot
  // without holding a permit and the pool would start queueing again.
  const admittedCheckout = async (): Promise<PoolClient> => {
    let releasePermit: (() => void) | undefined;
    let permitReturned = false;
    const returnPermit = () => {
      if (permitReturned) return;
      permitReturned = true;
      releasePermit?.();
    };
    await new Promise<void>((admitted) => {
      void withMainReadSlot(key, permits, () => {
        admitted();
        return new Promise<void>((done) => {
          releasePermit = done;
        });
      });
    });
    try {
      const client = await nativeConnect();
      const nativeRelease = client.release.bind(client) as (
        ...a: unknown[]
      ) => unknown;
      let released = false;
      const watchdog = setTimeout(returnPermit, READ_PERMIT_WATCHDOG_MS);
      watchdog.unref?.();
      client.release = ((...releaseArgs: unknown[]) => {
        if (released) return undefined;
        released = true;
        clearTimeout(watchdog);
        try {
          return nativeRelease(...releaseArgs);
        } finally {
          returnPermit();
        }
      }) as PoolClient["release"];
      return client;
    } catch (error) {
      // Never leak the permit when the checkout itself fails.
      returnPermit();
      throw error;
    }
  };

  Reflect.set(pool, "connect", (...args: unknown[]) => {
    const callback =
      typeof args[0] === "function" ? (args[0] as ConnectCallback) : undefined;
    const checkout = admittedCheckout();
    if (!callback) return checkout;
    // Callback form — this is the path `Pool.prototype.query` takes. It expects
    // node-postgres' `(err, client, done)` contract and ignores the return
    // value, so the promise must be settled here rather than handed back.
    void checkout.then(
      (client) => callback(undefined, client, client.release),
      (error: unknown) =>
        callback(
          error instanceof Error ? error : new Error(String(error)),
          undefined,
          () => {},
        ),
    );
    return undefined;
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

// Pinned in EVERY environment, not just dev-HMR. Pool identity would otherwise
// depend on this module being evaluated exactly once per isolate, and Next's
// route chunking can hand a second copy of a shared module its own module
// scope. Each copy would then build its own `max: 2` mirror pool, so one
// isolate quietly consumes four of the mirror role's 30 shared sessions instead
// of two. `main-read-limiter.ts` is pinned unconditionally for the same reason;
// a limiter shared across copies in front of unshared pools is worse than
// either alone. No-op when the module really is evaluated once.
globalForMainDb.mainReadDbPools = readPools;
globalForMainDb.mainReadDrizzleClients = readClients;
globalForMainDb.mainPrimaryDbPools = primaryPools;
globalForMainDb.mainPrimaryDrizzleClients = primaryClients;

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
