import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { readDbEnv } from "@/lib/db-env";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getMetricsScope } from "@/lib/metrics/scope";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

/**
 * Dashboard Reward Costs card — "Rakeback claims" SAME-DAY-WAGER split
 * (owner request, 2026-07-03: "show how much of the rakeback came from
 * wager from this day, cuz rn it merges all").
 *
 * WHY THIS EXISTS: the card's "Rakeback claims" line sums every
 * `rakeback_claim` ledger row CREATED today — i.e. every claim a user
 * SETTLED today, regardless of which day's wagering it was accrued from.
 * `rakeback_claims` (the source table behind that ledger row) records
 * `rakeback_type` (daily/weekly/monthly) + `period_start` (the date the
 * accrual period began), so a claim settled today can cover wagering from
 * a PRIOR calendar day (a normal daily claim settles YESTERDAY's already-
 * closed period; a weekly/monthly claim's period spans 7/30 days by
 * definition) or from TODAY itself (an early/instant claim on a still-open
 * daily period, `rakeback_config.early_claim_payout_percent` — see
 * `rakeback-instant-claim.ts`).
 *
 * A claim's underlying wager can be attributed ENTIRELY to today ONLY when
 * `rakeback_type = 'daily'` AND `period_start` = today's UTC calendar date
 * — a daily period never spans more than one day, so this is exact, not an
 * estimate. Weekly/monthly claims are excluded from this figure even if
 * `period_start` happens to fall on today (their period is never a single
 * day), so this metric can only ever be a SUBSET of the card's "Rakeback
 * claims" total, never exceed it.
 *
 * Scope matches the card's existing "Rakeback claims" line exactly
 * (`getMetricsScope()`: staff + creators + blacklist dropped, creator-
 * on-session rows excluded) so "$X of $Y" reconciles.
 *
 * INDEX-OR-CLICKHOUSE: `rakeback_claims` has no `to_regclass` guard because
 * two existing direct-Postgres readers already query it unconditionally
 * (`insights-rewards/rakeback/daily.ts`, `rakeback-instant-claim.ts`) — the
 * table is a foundational, always-present part of the rakeback feature.
 * This is a live/per-window, money-exact dashboard read bounded to a single
 * UTC day (Path 1 — indexed Postgres), matching the precedent set by
 * `dashboard-cashflow-pg.ts` / `dashboard-deposit-funded-ggr.ts`: it does
 * NOT route through the reward-costs `resolveAdminRead`/ClickHouse pipeline
 * — it is an independent, additive overlay figure, not a new cost line.
 */

async function computeRakebackFromTodayWager(sinceIso: string): Promise<number> {
  return withTiming("dashboard.rakebackFromTodayWager", async () => {
    const db = await getDb();
    const scope = await getMetricsScope();
    const since = `'${sinceIso}'::timestamptz`;
    const todayDate = `'${sinceIso.slice(0, 10)}'::date`;
    // Flat-fragment scope style (no CTE): this is a standalone single-table
    // query with no other WITH clauses, so it uses `exclStaffSessionFrag`
    // (self-contained `AND user_id IN (...) AND NOT EXISTS (...)`, inlines
    // the session windows as a sub-relation) instead of the CTE-style
    // `notInCreatorSession`, which requires `WITH ${scope.sessionWindowsCte}`
    // to be declared first — omitting that CTE (as an earlier version of
    // this query did) makes Postgres throw "relation session_windows does
    // not exist" on every call, which safeQuery swallows to `null`, so the
    // dashboard sub-line silently never rendered.
    const scopeFrag = scope.exclStaffSessionFrag({
      userCol: "rc.user_id",
      tsCol: "rc.claimed_at",
    });

    type Row = { same_day_amount: string };
    const rows = await db.$queryRawUnsafe<Row[]>(
      `SELECT COALESCE(SUM(rc.rakeback_amount_usd::numeric), 0)::text AS same_day_amount
       FROM rakeback_claims rc
       WHERE rc.claimed_at IS NOT NULL
         AND rc.claimed_at >= ${since}
         AND rc.rakeback_type = 'daily'
         AND rc.period_start = ${todayDate}
         ${scopeFrag}`,
    );

    return toNumber(rows[0]?.same_day_amount);
  });
}

const cachedRakebackFromTodayWager = unstable_cache(
  async (dayKey: string, sinceIso: string, blacklistKey: string): Promise<number> => {
    void dayKey; // cache-key discriminator only (rolls over at 00:00 UTC)
    void blacklistKey; // cache-key discriminator only (scope re-resolves it)
    return computeRakebackFromTodayWager(sinceIso);
  },
  ["dashboard-rakeback-same-day-v1"],
  { revalidate: 60, tags: ["dashboard-activity"] },
);

/** UTC start-of-day for `now`. Mirrors `dashboard-reward-costs-today.ts`. */
function utcStartOfDay(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Sum of rakeback claimed today whose underlying wager ALSO happened today
 * (daily-cadence claims with `period_start` = today). A SUBSET of the
 * Reward Costs card's "Rakeback claims" total — never exceeds it. Cached
 * 60s on prod (dev-toggled admins bypass to a live read), matching the
 * rest of the dashboard's activity-cached tiles.
 */
export async function getRakebackFromTodayWager(): Promise<number> {
  const now = new Date();
  const since = utcStartOfDay(now);
  const sinceIso = since.toISOString();
  const dayKey = sinceIso.slice(0, 10);
  const blacklist = await getExcludedUserIds();
  const blacklistKey = [...blacklist].sort().join(",");
  const env = await readDbEnv();
  if (env !== "prod") return computeRakebackFromTodayWager(sinceIso);
  return cachedRakebackFromTodayWager(dayKey, sinceIso, blacklistKey);
}
