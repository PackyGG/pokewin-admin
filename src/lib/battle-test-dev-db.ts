import "server-only";

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import type { MainDrizzleDb } from "@/lib/db";
import * as mainSchema from "@/lib/db-schema/main/schema";

const globalForBattleTestDevDb = globalThis as unknown as {
  battleTestDevReadPool: Pool | undefined;
  battleTestDevReadClient: MainDrizzleDb | undefined;
};

let battleTestDevReadPool = globalForBattleTestDevDb.battleTestDevReadPool;
let battleTestDevReadClient = globalForBattleTestDevDb.battleTestDevReadClient;

function parsedDatabaseUrl(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid PostgreSQL connection URL`);
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${name} is not a PostgreSQL connection URL`);
  }
  return url;
}

function databaseIdentity(url: URL): string {
  return [
    url.hostname.toLowerCase(),
    url.port || "5432",
    decodeURIComponent(url.pathname),
    decodeURIComponent(url.username),
  ].join("|");
}

function battleTestDevConnectionString(): string {
  const value = process.env.BATTLE_TEST_DEV_DATABASE_URL?.trim();
  if (!value) {
    throw new Error(
      "BATTLE_TEST_DEV_DATABASE_URL is not configured on this server",
    );
  }

  const url = parsedDatabaseUrl(value, "BATTLE_TEST_DEV_DATABASE_URL");
  const battleTestIdentity = databaseIdentity(url);
  const productionUrls = [
    process.env.MIRROR_PRODUCTION_DB,
    process.env.DATABASE_URL_POOLED,
    process.env.DATABASE_URL,
  ];

  for (const productionValue of productionUrls) {
    const trimmed = productionValue?.trim();
    if (!trimmed) continue;
    const productionUrl = parsedDatabaseUrl(trimmed, "production database URL");
    if (databaseIdentity(productionUrl) === battleTestIdentity) {
      throw new Error(
        "BATTLE_TEST_DEV_DATABASE_URL must not point at a production database",
      );
    }
  }

  if (
    url.searchParams.get("sslmode") === "require" &&
    !url.searchParams.has("uselibpqcompat")
  ) {
    url.searchParams.set("uselibpqcompat", "true");
  }
  return url.toString();
}

function createBattleTestDevReadPool(): Pool {
  const pool = new Pool({
    connectionString: battleTestDevConnectionString(),
    application_name: "pokewin-admin-battle-test-dev-read",
    min: 0,
    max: 1,
    maxUses: 100,
    idleTimeoutMillis: 1_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
    idle_in_transaction_session_timeout: 10_000,
    maxLifetimeSeconds: 600,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
    allowExitOnIdle: true,
    options: "-c default_transaction_read_only=on -c TimeZone=UTC",
  });
  pool.on("error", (error) => {
    console.error("[db:battle-test-dev:read] Pool error:", error.message);
  });
  return pool;
}

/** Dedicated read-only access to the real battle-testing development DB. */
export function getBattleTestDevReadDrizzleDb(): MainDrizzleDb {
  if (battleTestDevReadClient) return battleTestDevReadClient;

  const pool = battleTestDevReadPool ?? createBattleTestDevReadPool();
  const client = drizzle(pool, { schema: mainSchema });
  battleTestDevReadPool = pool;
  battleTestDevReadClient = client;

  if (process.env.NODE_ENV !== "production") {
    globalForBattleTestDevDb.battleTestDevReadPool = pool;
    globalForBattleTestDevDb.battleTestDevReadClient = client;
  }
  return client;
}
