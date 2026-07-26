import pg from "pg";

import type { Config } from "./config.js";

const { Pool } = pg;

function sslFor(mode: "disable" | "require"): false | { rejectUnauthorized: false } {
  return mode === "disable" ? false : { rejectUnauthorized: false };
}

export type Databases = {
  source: pg.Pool;
  antifraud: pg.Pool;
};

export function createDatabases(config: Config): Databases {
  const source = new Pool({
    connectionString: config.SOURCE_DATABASE_URL,
    ssl: sslFor(config.SOURCE_DATABASE_SSL),
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    options: "-c default_transaction_read_only=on -c statement_timeout=10000",
    application_name: "packy-antifraud-source-reader",
  });

  const antifraud = new Pool({
    connectionString: config.ANTIFRAUD_DATABASE_URL,
    ssl: sslFor(config.ANTIFRAUD_DATABASE_SSL),
    max: 12,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    options: "-c statement_timeout=15000",
    application_name: "packy-antifraud",
  });

  return { source, antifraud };
}

export async function assertDatabaseConnections(db: Databases): Promise<void> {
  await Promise.all([
    db.source.query("SELECT 1"),
    db.antifraud.query("SELECT 1"),
  ]);
}

export async function closeDatabases(db: Databases): Promise<void> {
  await Promise.all([db.source.end(), db.antifraud.end()]);
}
