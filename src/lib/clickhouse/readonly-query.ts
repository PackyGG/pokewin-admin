import "server-only";

import { logError } from "@/lib/errors/logger";

import { getClickHouseClient } from "./client";
import { assertReadOnlySql } from "./guards";

/**
 * Typed, read-only ClickHouse query helper.
 *
 *   const rows = await clickhouseRead.query<DashboardKpiRow>({
 *     queryName: "dashboard.today_kpis",
 *     sql: `SELECT toDate(created_at) AS day, sum(amount) AS total
 *           FROM ledger_transactions
 *           WHERE created_at >= {since:DateTime}
 *           GROUP BY day ORDER BY day`,
 *     params: { since },          // CH {name:Type} binding — never string-concat input
 *     timeoutMs: 15000,
 *   });
 *
 * Guarantees:
 *   • assertReadOnlySql() rejects any write/DDL before it reaches the server.
 *   • Only `query()` is exposed — no insert/command/exec path exists here.
 *   • Per-query `max_execution_time` (server-side kill) + AbortSignal timeout
 *     (client-side) bound runaway queries.
 *   • Throws ClickHouseUnavailableError when dormant (no client) so the caller's
 *     feature-flag layer can degrade (comparison → serve Postgres; clickhouse →
 *     serve cached/error — never silently re-run the heavy Postgres aggregate).
 *   • Returns typed rows parsed from JSONEachRow.
 */

export const DEFAULT_CH_TIMEOUT_MS = 15_000;
const CH_SLOW_MS = 2_000;

/** Thrown when ClickHouse is not configured (dormant) — distinct from a query error. */
export class ClickHouseUnavailableError extends Error {
  constructor(queryName: string) {
    super(`ClickHouse is not configured (query "${queryName}")`);
    this.name = "ClickHouseUnavailableError";
  }
}

/** Thrown when a ClickHouse query fails on the server / in transit. */
export class ClickHouseQueryError extends Error {
  readonly queryName: string;
  constructor(queryName: string, cause: unknown) {
    super(
      `ClickHouse query "${queryName}" failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "ClickHouseQueryError";
    this.cause = cause;
    this.queryName = queryName;
  }
}

export type ClickHouseReadOptions = {
  /** Dot-namespaced tag for observability/logging, e.g. "dashboard.today_kpis". */
  queryName: string;
  /** A single read-only statement. Guarded by assertReadOnlySql(). */
  sql: string;
  /** Bound parameters using ClickHouse `{name:Type}` placeholders in `sql`. */
  params?: Record<string, unknown>;
  /** Wall-clock + server execution bound. Defaults to DEFAULT_CH_TIMEOUT_MS. */
  timeoutMs?: number;
};

async function query<T>(opts: ClickHouseReadOptions): Promise<T[]> {
  assertReadOnlySql(opts.sql);

  const client = getClickHouseClient();
  if (!client) throw new ClickHouseUnavailableError(opts.queryName);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_CH_TIMEOUT_MS;
  const startedAt = Date.now();
  try {
    const resultSet = await client.query({
      query: opts.sql,
      query_params: opts.params,
      format: "JSONEachRow",
      clickhouse_settings: {
        // Server-side statement kill (seconds), independent of the client abort.
        max_execution_time: Math.max(1, Math.ceil(timeoutMs / 1000)),
      },
      abort_signal: AbortSignal.timeout(timeoutMs),
    });
    const rows = await resultSet.json<T>();
    const durationMs = Date.now() - startedAt;
    if (durationMs > CH_SLOW_MS) {
      console.warn(
        `[clickhouse] SLOW ${opts.queryName} ${durationMs}ms rows=${rows.length}`,
      );
    }
    return rows;
  } catch (cause) {
    logError(`clickhouse.${opts.queryName}`, "ClickHouse query failed", cause);
    throw new ClickHouseQueryError(opts.queryName, cause);
  }
}

export const clickhouseRead = { query };
