import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolClient } from "pg";
import * as adminSchema from "@/lib/db-schema/admin/schema";
import { acquireDatabaseSlot } from "@/lib/main-read-limiter";
import { currentQueryAbortSignal } from "@/lib/query-deadline";

export type AdminDrizzleDb = NodePgDatabase<typeof adminSchema>;

const globalForAdminDb = globalThis as unknown as {
  adminPool: Pool | undefined;
  adminDrizzle: AdminDrizzleDb | undefined;
};

function adminDatabaseUrl(): string {
  const connectionString =
    process.env.ADMIN_DATABASE_URL_POOLED ?? process.env.ADMIN_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "ADMIN_DATABASE_URL_POOLED or ADMIN_DATABASE_URL must be configured",
    );
  }
  return connectionString.trim();
}

/**
 * True when the connection string points at the PgBouncer transaction pooler
 * rather than the Postgres primary. The pooler multiplexes many short-lived
 * client connections onto a small fixed set of server connections, so the
 * per-instance cap below no longer has to defend the database's own
 * `max_connections`.
 */
function usingTransactionPooler(): boolean {
  return Boolean(process.env.ADMIN_DATABASE_URL_POOLED?.trim());
}

function createPool(): Pool {
  const pooled = usingTransactionPooler();
  const max = process.env.VERCEL ? (pooled ? 4 : 1) : 5;
  const pool = new Pool({
    // Prefer the managed runtime pooler. Keep ADMIN_DATABASE_URL pointed at
    // the direct endpoint for schema tooling.
    connectionString: adminDatabaseUrl(),
    application_name: "pokewin-admin",
    min: 0,
    // Every warm serverless instance owns its pool. Production has previously
    // exhausted the Admin database when warm instances retained two sessions
    // each, which is why the direct path is pinned to a single connection.
    //
    // That cap is a availability guard, not a performance choice: it fully
    // SERIALIZES every Admin read in a request, and the antifraud workspaces
    // are Admin-DB-backed, so their pages paid the sum of their queries rather
    // than the max. With PgBouncer in front (transaction pooling) the database
    // only ever sees `default_pool_size` server connections no matter how many
    // isolates are warm, so a small per-instance concurrency is safe again and
    // the serialization disappears.
    //
    // Sizing: 4 per instance against max_client_conn=100 tolerates ~25 warm
    // isolates, while the backend never exceeds the pooler's 20 server
    // connections out of the database's 97 usable.
    max,
    idleTimeoutMillis: 10_000,
    // The acquire budget MUST outlast the worst statement we permit. pg-pool
    // arms `connectionTimeoutMillis` on the QUEUE WAIT as well as on the TCP
    // connect, so with a 10s budget and a 30s `statement_timeout` one slow
    // Admin query starved every sibling queued behind it — including the
    // `verifySession()` read every request makes — with `timeout exceeded when
    // trying to connect`, which is not a query timeout and has no page-level
    // fallback. 35s matches the MAIN primary pools in `src/lib/db.ts`.
    connectionTimeoutMillis: 35_000,
    // Railway's managed PgBouncer rejects these as unsupported startup
    // parameters. Pooled sessions inherit the same 30s limits from the Admin
    // database defaults; the direct path keeps sending them explicitly.
    ...(!pooled
      ? {
          statement_timeout: 30_000,
          idle_in_transaction_session_timeout: 30_000,
        }
      : {}),
    maxLifetimeSeconds: 600,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
    allowExitOnIdle: true,
  });
  pool.on("error", (error) => {
    console.error("[admin-db] Pool error:", error.message);
  });
  return withAdminAdmissionControl(pool, max);
}

type ConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  done: PoolClient["release"],
) => void;

/**
 * Keep abandoned Admin reads out of pg-pool's opaque queue.
 *
 * PgBouncer protects PostgreSQL from client fan-out, but it does not fix the
 * local `pg.Pool` queue: a page that times out after 15s used to leave its
 * checkout waiting for up to 35s, after which stale work could still execute.
 * This process-wide, deadline-aware gate keeps that queue empty. We do not
 * destroy an active Admin checkout on abort because the same pool also carries
 * writes; PostgreSQL's 30s statement/transaction limits remain their backstop.
 */
export function withAdminAdmissionControl(pool: Pool, permits: number): Pool {
  const nativeConnect = pool.connect.bind(pool) as () => Promise<PoolClient>;

  const admittedCheckout = async (): Promise<PoolClient> => {
    const releasePermit = await acquireDatabaseSlot(
      "admin:connection",
      permits,
      currentQueryAbortSignal(),
    );
    try {
      const client = await nativeConnect();
      const nativeRelease = client.release.bind(client) as (
        ...args: unknown[]
      ) => unknown;
      let released = false;
      client.release = ((...args: unknown[]) => {
        if (released) return undefined;
        released = true;
        try {
          return nativeRelease(...args);
        } finally {
          releasePermit();
        }
      }) as PoolClient["release"];
      return client;
    } catch (error) {
      releasePermit();
      throw error;
    }
  };

  Reflect.set(pool, "connect", (...args: unknown[]) => {
    const callback =
      typeof args[0] === "function" ? (args[0] as ConnectCallback) : undefined;
    const checkout = admittedCheckout();
    if (!callback) return checkout;
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

const adminPool = globalForAdminDb.adminPool ?? createPool();

export const adminDrizzle: AdminDrizzleDb =
  globalForAdminDb.adminDrizzle ??
  drizzle(adminPool, {
    schema: adminSchema,
    casing: "snake_case",
  });

// Pin in production too. Next route chunking can evaluate this module more
// than once in one isolate; module-local pools would multiply the configured
// connection cap and defeat both PgBouncer sizing and the direct-path guard.
globalForAdminDb.adminPool = adminPool;
globalForAdminDb.adminDrizzle = adminDrizzle;
