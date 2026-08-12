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

function createPool(): Pool {
  const pool = new Pool({
    // Prefer the managed runtime pooler. Keep ADMIN_DATABASE_URL pointed at
    // the direct endpoint for schema tooling.
    connectionString: adminDatabaseUrl(),
    application_name: "pokewin-admin",
    min: 0,
    // Every warm serverless instance owns its pool. Production has previously
    // exhausted the Admin database when warm instances retained two sessions
    // each. Keep one connection per instance and serialize the now-bounded
    // request-local reads; the managed transaction pooler can still multiplex
    // across instances when ADMIN_DATABASE_URL_POOLED is configured.
    max: process.env.VERCEL ? 1 : 5,
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
