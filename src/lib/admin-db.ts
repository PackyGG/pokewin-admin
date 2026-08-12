import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as adminSchema from "@/lib/db-schema/admin/schema";

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
    // Sizing: 4 per instance against max_client_conn=500 tolerates ~125 warm
    // isolates, while the backend never exceeds the pooler's 20 server
    // connections out of the database's 97 usable.
    max: process.env.VERCEL ? (pooled ? 4 : 1) : 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 30_000,
    maxLifetimeSeconds: 600,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
    allowExitOnIdle: true,
  });
  pool.on("error", (error) => {
    console.error("[admin-db] Pool error:", error.message);
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

if (process.env.NODE_ENV !== "production") {
  globalForAdminDb.adminPool = adminPool;
  globalForAdminDb.adminDrizzle = adminDrizzle;
}
