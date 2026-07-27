import pg from "pg";

import type { Config } from "./config.js";

const { Pool } = pg;

function sslFor(
  mode: "disable" | "require",
  ca?: string,
): false | { rejectUnauthorized: true; ca?: string } {
  return mode === "disable"
    ? false
    : {
        rejectUnauthorized: true,
        ...(ca ? { ca: ca.replace(/\\n/g, "\n") } : {}),
      };
}

export function sourceSslFor(
  mode: "disable" | "require",
  ca?: string,
):
  | false
  | { rejectUnauthorized: false }
  | { rejectUnauthorized: true; ca: string } {
  if (mode === "disable") return false;
  if (ca) {
    return {
      rejectUnauthorized: true,
      ca: ca.replace(/\\n/g, "\n"),
    };
  }
  // The Coolify mirror uses a private CA that is not present in Railway's
  // trust store. Keep transport encrypted while matching libpq's documented
  // sslmode=require behavior. Supplying SOURCE_DATABASE_CA restores strict
  // certificate verification without any code change.
  return { rejectUnauthorized: false };
}

export type Databases = {
  source: pg.Pool;
  antifraud: pg.Pool;
};

export function createDatabases(config: Config): Databases {
  const source = new Pool({
    connectionString: config.SOURCE_DATABASE_URL,
    ssl: sourceSslFor(
      config.SOURCE_DATABASE_SSL,
      config.SOURCE_DATABASE_CA,
    ),
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    options:
      "-c default_transaction_read_only=on -c statement_timeout=10000 -c TimeZone=UTC",
    application_name: "packy-antifraud-source-reader",
  });

  const antifraud = new Pool({
    connectionString: config.ANTIFRAUD_DATABASE_URL,
    ssl: sslFor(
      config.ANTIFRAUD_DATABASE_SSL,
      config.ANTIFRAUD_DATABASE_CA,
    ),
    max: 12,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    options: "-c statement_timeout=15000 -c TimeZone=UTC",
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
