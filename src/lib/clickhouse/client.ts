import "server-only";

import { createClient, type ClickHouseClient } from "@clickhouse/client";

import { resolveClickHouseConfig } from "./env";

/**
 * ClickHouse Cloud read client — server-only, DORMANT BY DEFAULT.
 *
 * Same graceful-degrade contract as src/lib/cache/redis.ts: if the
 * CLICKHOUSE_* env is absent (or construction fails), `getClickHouseClient()`
 * returns `null` and every read path falls back to Postgres — behavior is
 * identical to today. This module never throws at import time and never throws
 * here.
 *
 * READ-ONLY: the connection is created with the session setting `readonly = 2`
 * (reads + may set per-query execution limits, but NO writes/DDL ever). Combined
 * with the SQL guard in ./guards.ts and the fact that the read helper only
 * exposes `query()`, the app can never mutate ClickHouse. Writes to ClickHouse
 * (read-model migrations / rollups) are an explicit, separate, owner-run path —
 * never normal app code.
 */

// Cache the resolved client on globalThis so dev HMR reloads reuse one client
// (keep-alive sockets) instead of leaking a new one each reload — same pattern
// as src/lib/db.ts. `undefined` = unresolved; `null` = resolved-to-dormant.
const globalForClickHouse = globalThis as unknown as {
  __chReadClient?: ClickHouseClient | null;
};

export function getClickHouseClient(): ClickHouseClient | null {
  if (globalForClickHouse.__chReadClient !== undefined) {
    return globalForClickHouse.__chReadClient;
  }

  const cfg = resolveClickHouseConfig();
  if (!cfg) {
    globalForClickHouse.__chReadClient = null;
    return null;
  }

  try {
    globalForClickHouse.__chReadClient = createClient({
      url: cfg.url,
      username: cfg.username,
      password: cfg.password,
      database: cfg.database,
      // Client-level abort if a request hangs (per-query limits are set in the
      // read helper).
      request_timeout: 30_000,
      clickhouse_settings: {
        // `"2"` (not `"1"`) so the read helper may still raise per-query
        // execution limits like max_execution_time; `"2"` still forbids ALL
        // writes/DDL. (ClickHouse settings are typed as strings.)
        readonly: "2",
      },
    });
  } catch {
    // A bad URL/credential shape must not break callers — stay dormant.
    globalForClickHouse.__chReadClient = null;
  }

  return globalForClickHouse.__chReadClient;
}

/** True only when a usable ClickHouse read client is configured. */
export function isClickHouseEnabled(): boolean {
  return getClickHouseClient() !== null;
}
