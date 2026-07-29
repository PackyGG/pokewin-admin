import "server-only";

import { queryMainRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { WAGER_TYPES_SQL as METRICS_WAGER_TYPES_SQL } from "@/lib/metrics";
import {
  fiatRefundAttributionTimestampSql,
  fiatRefundCreditUsdSql,
} from "./fiat-refund-credits";

/**
 * Shared rolling-window KPI query for deposits, withdrawals, and customer
 * wager — the SAME SQL the Analytics Insights overview tab uses
 * (`runPeriodWindowQuery`). Top bar pills, Edge Plan 2 baseline wager, and
 * `/insights/analytics` Overview all read through this module so a 30d
 * window shows identical figures everywhere.
 *
 * Wager leg = ledger pack/battle types (ex creator on-stream via
 * `session_windows`). The ledger leg intentionally does NOT apply
 * `WAGER_LEG_FILTER` (borrow/reward-pack exclusion) — it matches the
 * Insights "Wager" tile ("Customer wager, ex creator on-stream").
 */

export type PeriodWindowRow = {
  deposits: string;
  deposit_count: string;
  withdrawals: string;
  wager: string;
  wager_organic: string;
  wager_creator_coded: string;
  signups: string;
  active: string;
};

export type PeriodWindowKpis = {
  deposits: number;
  depositCount: number;
  withdrawals: number;
  /** Customer wager (ledger pack/battle, ex creator on-stream). */
  wager: number;
  wagerOrganic: number;
  wagerCreatorCoded: number;
  newSignups: number;
  uniqueActive: number;
};

export type PeriodWindowQueryArgs = {
  currentCutoff: Date;
  previousStart: Date | null;
  previousEnd: Date | null;
  blacklistIdNotIn: string;
  sessionWindowsCte: string;
};

export function parsePeriodWindowRow(r: PeriodWindowRow): PeriodWindowKpis {
  return {
    deposits: toNumber(r.deposits),
    depositCount: Number(r.deposit_count),
    withdrawals: toNumber(r.withdrawals),
    wager: toNumber(r.wager),
    wagerOrganic: toNumber(r.wager_organic),
    wagerCreatorCoded: toNumber(r.wager_creator_coded),
    newSignups: Number(r.signups),
    uniqueActive: Number(r.active),
  };
}

/**
 * Deposits / withdrawals / wager / organic / signups / active for a current
 * window and an optional previous window (for delta chips). Byte-identical
 * to the query previously inlined in `insights-analytics/overview.ts`.
 */
export async function runPeriodWindowQuery(
  args: PeriodWindowQueryArgs,
): Promise<{ current: PeriodWindowRow; previous: PeriodWindowRow }> {
  const {
    currentCutoff,
    previousStart,
    previousEnd,
    blacklistIdNotIn,
    sessionWindowsCte,
  } = args;

  const prevStart = previousStart ?? new Date(0);
  const prevEnd = previousEnd ?? new Date(0);
  const baseSince = prevStart < currentCutoff ? prevStart : currentCutoff;
  const rows = await queryMainRows<
    {
      window: "current" | "previous";
      deposits: string;
      deposit_count: string;
      withdrawals: string;
      wager: string;
      wager_organic: string;
      wager_creator_coded: string;
      signups: string;
      active: string;
    }[]
  >(
    `
    WITH real_users AS (
      SELECT u.id, u.role, u.created_at AS signup_at,
             EXISTS (
               SELECT 1 FROM "user" ref
               WHERE ref.id = u.referred_by AND ref.role = 'creator'
             ) AS under_creator
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support', 'creator') ${blacklistIdNotIn}
    ),
    ${sessionWindowsCte},
    base AS (
      SELECT lt.user_id, lt.type, lt.amount::numeric AS amount, lt.created_at,
             ru.under_creator,
             CASE WHEN ru.role = 'creator'
                  THEN EXISTS (
                    SELECT 1 FROM session_windows sw
                    WHERE sw.uid = lt.user_id
                      AND lt.created_at >= sw.win_start
                      AND lt.created_at <  sw.win_end
                  )
                  ELSE false END AS in_session
      FROM ledger_transactions lt
      JOIN real_users ru ON ru.id = lt.user_id
      WHERE lt.status = 'completed' AND lt.created_at >= $1
    ),
    withdrawals AS (
      SELECT
        cwr.total_value_usd::numeric AS amount,
        COALESCE(cwr.completed_at, cwr.shipped_at) AS effective_at
      FROM card_withdrawal_requests cwr
      JOIN real_users ru ON ru.id = cwr.user_id
      WHERE cwr.status IN ('completed', 'shipped')
    ),
    fiat_refunds AS (
      SELECT ${fiatRefundCreditUsdSql("i")} AS amount,
             ${fiatRefundAttributionTimestampSql("i")} AS effective_at
      FROM fiat_deposit_intents i
      JOIN real_users ru ON ru.id = i.user_id
      WHERE i.status IN ('partially_refunded', 'refunded')
        AND ${fiatRefundAttributionTimestampSql("i")} >= $1
    )
    SELECT
      'current'::text AS window,
      (
        COALESCE(SUM(CASE WHEN type::text = 'deposit' AND created_at >= $2 THEN amount ELSE 0 END), 0)
        - COALESCE((SELECT SUM(amount) FROM fiat_refunds WHERE effective_at >= $2), 0)
      )::text AS deposits,
      COUNT(CASE WHEN type::text = 'deposit' AND created_at >= $2 THEN 1 END)::text AS deposit_count,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= $2 THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawals,
      COALESCE(SUM(CASE WHEN type::text IN ${METRICS_WAGER_TYPES_SQL} AND NOT in_session AND created_at >= $2 THEN ABS(amount) ELSE 0 END), 0)::text AS wager,
      COALESCE(SUM(CASE WHEN type::text IN ${METRICS_WAGER_TYPES_SQL} AND NOT in_session AND NOT under_creator AND created_at >= $2 THEN ABS(amount) ELSE 0 END), 0)::text AS wager_organic,
      COALESCE(SUM(CASE WHEN type::text IN ${METRICS_WAGER_TYPES_SQL} AND NOT in_session AND under_creator AND created_at >= $2 THEN ABS(amount) ELSE 0 END), 0)::text AS wager_creator_coded,
      (SELECT COUNT(*)::text FROM real_users WHERE signup_at >= $2) AS signups,
      COUNT(DISTINCT CASE WHEN created_at >= $2 THEN user_id END)::text AS active
    FROM base
    UNION ALL
    SELECT
      'previous'::text AS window,
      (
        COALESCE(SUM(CASE WHEN type::text = 'deposit' AND created_at >= $3 AND created_at < $4 THEN amount ELSE 0 END), 0)
        - COALESCE((SELECT SUM(amount) FROM fiat_refunds WHERE effective_at >= $3 AND effective_at < $4), 0)
      )::text AS deposits,
      COUNT(CASE WHEN type::text = 'deposit' AND created_at >= $3 AND created_at < $4 THEN 1 END)::text AS deposit_count,
      COALESCE((SELECT SUM(CASE WHEN effective_at >= $3 AND effective_at < $4 THEN amount ELSE 0 END) FROM withdrawals), 0)::text AS withdrawals,
      COALESCE(SUM(CASE WHEN type::text IN ${METRICS_WAGER_TYPES_SQL} AND NOT in_session AND created_at >= $3 AND created_at < $4 THEN ABS(amount) ELSE 0 END), 0)::text AS wager,
      COALESCE(SUM(CASE WHEN type::text IN ${METRICS_WAGER_TYPES_SQL} AND NOT in_session AND NOT under_creator AND created_at >= $3 AND created_at < $4 THEN ABS(amount) ELSE 0 END), 0)::text AS wager_organic,
      COALESCE(SUM(CASE WHEN type::text IN ${METRICS_WAGER_TYPES_SQL} AND NOT in_session AND under_creator AND created_at >= $3 AND created_at < $4 THEN ABS(amount) ELSE 0 END), 0)::text AS wager_creator_coded,
      (SELECT COUNT(*)::text FROM real_users WHERE signup_at >= $3 AND signup_at < $4) AS signups,
      COUNT(DISTINCT CASE WHEN created_at >= $3 AND created_at < $4 THEN user_id END)::text AS active
    FROM base
    `,
    baseSince,
    currentCutoff,
    prevStart,
    prevEnd,
  );

  const current = rows.find((r) => r.window === "current");
  const prev = rows.find((r) => r.window === "previous");
  if (!current || !prev) {
    throw new Error("period-window-kpis: window query returned 0 rows");
  }
  return { current, previous: prev };
}
