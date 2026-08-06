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

export function sourceConnectionString(
  connectionString: string,
  mode: "disable" | "require",
  ca?: string,
): string {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("SOURCE_DATABASE_URL is invalid");
  }

  if (mode === "disable") {
    url.searchParams.set("sslmode", "disable");
    url.searchParams.delete("uselibpqcompat");
  } else if (ca) {
    url.searchParams.set("sslmode", "verify-full");
    url.searchParams.delete("uselibpqcompat");
  } else {
    // pg-connection-string otherwise aliases require to verify-full and
    // overwrites the Pool ssl object after parsing the connection string.
    url.searchParams.set("sslmode", "require");
    url.searchParams.set("uselibpqcompat", "true");
  }

  return url.toString();
}

export type Databases = {
  source: pg.Pool;
  fiatDevSource: pg.Pool | null;
  antifraud: pg.Pool;
};

function createSourcePool(input: {
  connectionString: string;
  mode: "disable" | "require";
  ca?: string;
  applicationName: string;
}): pg.Pool {
  const source = new Pool({
    connectionString: sourceConnectionString(
      input.connectionString,
      input.mode,
      input.ca,
    ),
    ssl: sourceSslFor(
      input.mode,
      input.ca,
    ),
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    options:
      "-c default_transaction_read_only=on -c statement_timeout=10000 -c TimeZone=UTC",
    application_name: input.applicationName,
  });
  source.on("error", (error) => {
    console.error("[source-db] idle pool client error", {
      name: error.name,
      message: error.message,
      code: (error as { code?: string }).code,
    });
  });
  return source;
}

export function createDatabases(config: Config): Databases {
  const source = createSourcePool({
    connectionString: config.SOURCE_DATABASE_URL,
    mode: config.SOURCE_DATABASE_SSL,
    ca: config.SOURCE_DATABASE_CA,
    applicationName: "packy-antifraud-source-reader",
  });
  const fiatDevSource = config.FIAT_ELIGIBILITY_DEV_SOURCE_DATABASE_URL
    ? createSourcePool({
        connectionString: config.FIAT_ELIGIBILITY_DEV_SOURCE_DATABASE_URL,
        mode: config.FIAT_ELIGIBILITY_DEV_SOURCE_DATABASE_SSL,
        ca: config.FIAT_ELIGIBILITY_DEV_SOURCE_DATABASE_CA,
        applicationName: "packy-antifraud-fiat-dev-reader",
      })
    : null;

  const antifraud = new Pool({
    connectionString: config.ANTIFRAUD_DATABASE_URL,
    ssl: sslFor(
      config.ANTIFRAUD_DATABASE_SSL,
      config.ANTIFRAUD_DATABASE_CA,
    ),
    // The dedicated Antifraud DB has ample headroom, and 12 was too tight: the
    // poller, both outbox drains and a couple of fan-out API routes could
    // together exceed it and push the poller past connectionTimeoutMillis.
    max: 24,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    options: "-c statement_timeout=15000 -c TimeZone=UTC",
    application_name: "packy-antifraud",
  });
  antifraud.on("error", (error) => {
    console.error("[antifraud-db] idle pool client error", {
      name: error.name,
      message: error.message,
      code: (error as { code?: string }).code,
    });
  });

  return { source, fiatDevSource, antifraud };
}

export async function assertDatabaseConnections(db: Databases): Promise<void> {
  // allSettled rather than all: Promise.all reports whichever pool rejected
  // first and hides the rest, so a readiness failure never said WHICH database
  // was down. Every probe still runs, and every failure is named.
  const probes: Array<{ name: string; run: Promise<unknown> }> = [
    { name: "source", run: db.source.query("SELECT 1") },
    { name: "antifraud", run: db.antifraud.query("SELECT 1") },
  ];
  if (db.fiatDevSource) {
    probes.push({
      name: "fiatDevSource",
      run: db.fiatDevSource.query("SELECT 1"),
    });
  }
  const results = await Promise.allSettled(probes.map((probe) => probe.run));
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [{ pool: probes[index]!.name, reason: result.reason as unknown }]
      : [],
  );
  if (failures.length === 0) return;
  for (const failure of failures) {
    const error = failure.reason;
    console.error("[db] connection probe failed", {
      pool: failure.pool,
      message: error instanceof Error ? error.message : String(error),
      code:
        error && typeof error === "object"
          ? (error as { code?: string }).code
          : undefined,
    });
  }
  throw new Error(
    `Database connection probe failed: ${failures
      .map((failure) => failure.pool)
      .join(", ")}`,
    { cause: failures[0]!.reason },
  );
}

export async function closeDatabases(db: Databases): Promise<void> {
  await Promise.all([
    db.source.end(),
    db.fiatDevSource?.end(),
    db.antifraud.end(),
  ]);
}
