import "server-only";

import { logQueryFailure } from "@/lib/errors/logger";

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
 *     timeoutMs: 8000,
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

/**
 * Default per-query wall-clock + server-execution budget (ms).
 *
 * Set to 8s (was 15s) as part of the 2026-07-01 thundering-herd incident fix.
 * The reason is the interaction with the caller's `safeQuery`/tile budget
 * (`REWARD_QUERY_TIMEOUT_MS` = 15s): if the CH per-query timeout equals that
 * budget, a genuinely SLOW ClickHouse races the tile timeout — the whole
 * segment's 15s is spent waiting on CH and there is NO headroom left to fall
 * back to Postgres before `safeQuery` itself times out and degrades the tile
 * to an error state.
 *
 * At 8s, a stalling CH read aborts (server-side kill + client AbortSignal)
 * roughly ~7s inside the tile budget, so `resolveAdminRead` still has ample
 * time to run the graceful-degradation Postgres leg (which the cron/warm cache
 * keeps warm) and serve real data before the tile budget elapses. Healthy CH
 * warm reads are sub-second, so 8s is generous headroom for the happy path and
 * only ever bites a truly stuck query.
 *
 * A non-dashboard heavy CH read that legitimately needs longer can still pass
 * an explicit `timeoutMs` per call to override this default.
 */
export const DEFAULT_CH_TIMEOUT_MS = 8_000;
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
        `[clickhouse] SLOW ${opts.queryName} duration_ms=${durationMs} rows=${rows.length}`,
      );
    }
    return rows;
  } catch (cause) {
    const durationMs = Date.now() - startedAt;
    // An AbortSignal.timeout fires a "TimeoutError"; the server-side
    // max_execution_time kill surfaces as a query error. Label the wall-clock
    // abort as a timeout, everything else as a hard error.
    const kind: "timeout" | "error" =
      cause instanceof Error &&
      (cause.name === "TimeoutError" || cause.name === "AbortError")
        ? "timeout"
        : "error";
    logQueryFailure(
      `clickhouse.${opts.queryName}`,
      { engine: "clickhouse", durationMs, kind },
      cause,
    );
    throw new ClickHouseQueryError(opts.queryName, cause);
  }
}

export const clickhouseRead = { query };
