import "server-only";

import { Pool, type QueryResultRow } from "pg";

const globalForCreatorAnalytics = globalThis as unknown as {
  creatorAnalyticsPool: Pool | undefined;
};
let creatorAnalyticsPool = globalForCreatorAnalytics.creatorAnalyticsPool;

function connectionString(): string {
  const configured = process.env.CREATOR_ANALYTICS_DATABASE_URL?.trim();
  if (!configured) {
    throw new Error("CREATOR_ANALYTICS_DATABASE_URL is not configured");
  }

  const url = new URL(configured);
  if (
    url.searchParams.get("sslmode") === "require" &&
    !url.searchParams.has("uselibpqcompat")
  ) {
    url.searchParams.set("uselibpqcompat", "true");
  }
  return url.toString();
}

function createPool(): Pool {
  const pool = new Pool({
    connectionString: connectionString(),
    application_name: "pokewin-admin-creator-analytics-read",
    min: 0,
    max: 1,
    maxUses: 100,
    idleTimeoutMillis: 1_000,
    connectionTimeoutMillis: 15_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 30_000,
    maxLifetimeSeconds: 600,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
    allowExitOnIdle: true,
    options: "-c default_transaction_read_only=on -c TimeZone=UTC",
  });
  pool.on("error", (error) => {
    console.error("[creator-analytics-db] Pool error:", error.message);
  });
  return pool;
}

function getPool(): Pool {
  if (creatorAnalyticsPool) return creatorAnalyticsPool;
  creatorAnalyticsPool = createPool();
  if (process.env.NODE_ENV !== "production") {
    globalForCreatorAnalytics.creatorAnalyticsPool = creatorAnalyticsPool;
  }
  return creatorAnalyticsPool;
}

/** Dedicated authoritative creator-history reads; every session is DB-enforced read-only. */
export async function queryCreatorAnalytics<T extends QueryResultRow>(
  text: string,
  values: readonly unknown[],
): Promise<T[]> {
  const result = await getPool().query<T>(text, [...values]);
  return result.rows;
}
