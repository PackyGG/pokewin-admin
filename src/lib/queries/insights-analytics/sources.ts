import { queryMainRows } from "@/lib/drizzle-query";
import "server-only";

import { unstable_cache } from "next/cache";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { periodToDays, type InsightsPeriod } from "./period";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { fiatRefundCreditUsdSql } from "@/lib/queries/fiat-refund-credits";

/**
 * Signup source breakdown. Two sub-tabs:
 *   • "buckets" — 3 buckets (organic / creator-affiliate / regular-
 *                  affiliate). Cohort metrics per bucket: signups,
 *                  first deposit, first wager, MAW, GGR, deposits.
 *   • "codes"   — per affiliate code: signups, first deposit %, GGR
 *                  driven, top 25 codes by signups in period.
 *
 * Staff (admin/support) + manual blacklist excluded.
 *
 * RESILIENCE + PERFORMANCE (mirrors `overview.ts` / `ltv.ts` in this
 * directory): both readers are heavy per-cohort scans, run behind a
 * period-keyed `unstable_cache` (300s, scope input in the key so a changed
 * blacklist can't serve a stale value, tagged `insights-analytics` /
 * `dashboard-lifetime`) and inside `safeQuery` with the canonical
 * heavy-read timeout so a slow/failed read degrades to an empty list
 * instead of pinning a MAIN pool slot and crashing the tab.
 *
 * Lifetime is bounded to a 365-day lookback (`SOURCES_LIFETIME_LOOKBACK_DAYS`)
 * for the cohort signup window AND the in-period ledger sums, rather than
 * the previous unbounded `created_at` scan (`periodToDays` → null → empty
 * filter), consistent with `INSIGHTS_LIFETIME_LOOKBACK_DAYS`
 * (insights-rewards) and `overview.ts`. PERFORMANCE bound only — finite
 * periods are unaffected.
 */

/**
 * Capped lookback (days) the lifetime ("lifetime" period) scans bound to
 * instead of an unbounded `created_at` filter — the unbounded-lifetime
 * pattern CLAUDE.md forbids. 365d, matching `INSIGHTS_LIFETIME_LOOKBACK_DAYS`
 * (insights-rewards `_period.ts`) and `overview.ts`'s
 * `OVERVIEW_LIFETIME_LOOKBACK_DAYS`.
 */
const SOURCES_LIFETIME_LOOKBACK_DAYS = 365;

/** Period → bounded day count: lifetime resolves to the 365d cap, not null. */
function cappedDaysForPeriod(period: InsightsPeriod): number {
  return periodToDays(period) ?? SOURCES_LIFETIME_LOOKBACK_DAYS;
}

export type SourcesSubTab = "buckets" | "codes";

export function parseSourcesSubTab(value: string | undefined): SourcesSubTab {
  return value === "codes" ? "codes" : "buckets";
}

export type SourceBucketRow = {
  key: string;
  label: string;
  signups: number;
  firstDeposit: number;
  firstWager: number;
  maw: number;
  ggrDriven: number;
  depositsDriven: number;
  wagerDriven: number;
  // Per-user averages
  avgGgr: number;
};

export type SourceCodeRow = {
  code: string;
  affiliateUserId: string | null;
  signups: number;
  firstDeposit: number;
  ggrDriven: number;
  wagerDriven: number;
};

const WAGER_TYPES_SQL = `('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')`;
const PAYOUT_TYPES_SQL = `('battle_refund','upgrader_payout','card_sale','reward_card_sale')`;
const MAW_CUTOFF_DAYS = 30;

type SourceBucketRawRow = {
  bucket: string;
  signups: string;
  first_deposit: string;
  first_wager: string;
  maw: string;
  ggr: string;
  deposits: string;
  wager: string;
};

/**
 * The buckets scan behind a period-keyed `unstable_cache`. Lifetime bounds
 * the cohort signup window AND the in-period ledger sums to
 * `cappedDaysForPeriod` (365d), not unbounded. Cache key carries the
 * period AND the blacklist scope; canonical tags bust it on a wipe/restore.
 */
const cachedSourcesBuckets = unstable_cache(
  async (
    period: InsightsPeriod,
    blacklistIdNotIn: string,
  ): Promise<SourceBucketRawRow[]> => {
    const days = cappedDaysForPeriod(period);
    const usersDateFilter = `AND u.created_at >= NOW() - INTERVAL '${days} days'`;
    const ledgerDateFilter = `AND lt.created_at >= NOW() - INTERVAL '${days} days'`;

    const groupExpr = `
      CASE
        WHEN u.referred_by IS NULL THEN 'organic'
        WHEN EXISTS (SELECT 1 FROM "user" ref WHERE ref.id = u.referred_by AND ref.role = 'creator')
          THEN 'creator-affiliate'
        ELSE 'regular-affiliate'
      END
    `;

    return queryMainRows<SourceBucketRawRow[]>(`
      WITH cohort AS (
        SELECT u.id, (${groupExpr}) AS bucket
        FROM "user" u
        WHERE u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
          ${usersDateFilter}
      ),
      refunds AS (
        SELECT i.user_id, SUM(${fiatRefundCreditUsdSql("i")}) AS amount
        FROM fiat_deposit_intents i
        JOIN cohort c ON c.id = i.user_id
        WHERE i.status IN ('partially_refunded', 'refunded')
          AND i.updated_at >= NOW() - INTERVAL '${days} days'
        GROUP BY i.user_id
      ),
      activity AS (
        SELECT
          c.id AS user_id,
          c.bucket,
          COUNT(*) FILTER (WHERE lt.type::text = 'deposit' AND lt.status = 'completed') AS deposit_count,
          COUNT(*) FILTER (WHERE lt.type::text IN ${WAGER_TYPES_SQL}
            AND lt.status = 'completed') AS wager_count,
          COUNT(*) FILTER (WHERE lt.type::text IN ${WAGER_TYPES_SQL}
            AND lt.status = 'completed'
            AND lt.created_at >= NOW() - INTERVAL '${MAW_CUTOFF_DAYS} days') AS wager_count_30d,
          COALESCE(SUM(CASE WHEN lt.type::text IN ${WAGER_TYPES_SQL} AND lt.status = 'completed' ${ledgerDateFilter}
            THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS wager_in_period,
          COALESCE(SUM(CASE WHEN lt.type::text IN ${PAYOUT_TYPES_SQL} AND lt.status = 'completed' ${ledgerDateFilter}
            THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS payouts_in_period,
          COALESCE(SUM(CASE WHEN lt.type::text = 'deposit' AND lt.status = 'completed' ${ledgerDateFilter}
            THEN lt.amount::numeric ELSE 0 END), 0)
            - COALESCE(MAX(r.amount), 0) AS deposits_in_period
        FROM cohort c
        LEFT JOIN ledger_transactions lt ON lt.user_id = c.id
        LEFT JOIN refunds r ON r.user_id = c.id
        GROUP BY c.id, c.bucket
      )
      SELECT
        bucket,
        COUNT(*)::text AS signups,
        COUNT(*) FILTER (WHERE deposit_count > 0)::text AS first_deposit,
        COUNT(*) FILTER (WHERE wager_count > 0)::text AS first_wager,
        COUNT(*) FILTER (WHERE wager_count_30d > 0)::text AS maw,
        COALESCE(SUM(wager_in_period - payouts_in_period), 0)::text AS ggr,
        COALESCE(SUM(deposits_in_period), 0)::text AS deposits,
        COALESCE(SUM(wager_in_period), 0)::text AS wager
      FROM activity
      GROUP BY bucket
      ORDER BY signups DESC
    `);
  },
  ["insights-analytics-sources-buckets-v2-refunds"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

export async function getSourcesBuckets(
  period: InsightsPeriod,
): Promise<SourceBucketRow[]> {
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);

  // Run the cached scan inside `safeQuery` (canonical heavy-read timeout,
  // empty fallback) so a slow/failed read degrades to an empty list
  // instead of pinning a MAIN pool slot and crashing the tab — the same
  // per-read resilience `getInsightsOverview` applies.
  const { data: rows } = await safeQuery(
    () => cachedSourcesBuckets(period, blacklistIdNotIn),
    [] as SourceBucketRawRow[],
    "insights-analytics.sources.buckets",
    REWARD_QUERY_TIMEOUT_MS,
  );

  return rows.map((r) => {
    const signups = Number(r.signups);
    const ggr = toNumber(r.ggr);
    return {
      key: r.bucket,
      label:
        r.bucket === "organic"
          ? "Organic"
          : r.bucket === "creator-affiliate"
            ? "Creator affiliate"
            : "Regular affiliate",
      signups,
      firstDeposit: Number(r.first_deposit),
      firstWager: Number(r.first_wager),
      maw: Number(r.maw),
      ggrDriven: ggr,
      depositsDriven: toNumber(r.deposits),
      wagerDriven: toNumber(r.wager),
      avgGgr: signups > 0 ? ggr / signups : 0,
    };
  });
}

type SourceCodeRawRow = {
  code: string;
  affiliate_user_id: string;
  signups: string;
  first_deposit: string;
  ggr: string;
  wager: string;
};

/**
 * The per-code scan behind a period-keyed `unstable_cache`. Lifetime
 * bounds the cohort signup window AND the in-period ledger sums to
 * `cappedDaysForPeriod` (365d), not unbounded. Cache key carries the
 * period AND the blacklist scope; canonical tags bust it on a wipe/restore.
 */
const cachedSourcesCodes = unstable_cache(
  async (
    period: InsightsPeriod,
    blacklistIdNotIn: string,
  ): Promise<SourceCodeRawRow[]> => {
    const days = cappedDaysForPeriod(period);
    const usersDateFilter = `AND u.created_at >= NOW() - INTERVAL '${days} days'`;
    const ledgerDateFilter = `AND lt.created_at >= NOW() - INTERVAL '${days} days'`;

    // Per-code aggregate. Codes here come from the `referred_by` lineage
    // (which references a user with an affiliate_code). The affiliate
    // code itself lives on the User row, so we join from the referred
    // user back through referred_by → user.affiliate_code.
    return queryMainRows<SourceCodeRawRow[]>(`
      WITH cohort AS (
        SELECT u.id, u.referred_by, ref.affiliate_code, ref.id AS affiliate_user_id
        FROM "user" u
        JOIN "user" ref ON ref.id = u.referred_by
        WHERE u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
          AND ref.affiliate_code IS NOT NULL
          ${usersDateFilter}
      ),
      activity AS (
        SELECT
          c.id AS user_id,
          c.affiliate_code AS code,
          c.affiliate_user_id,
          COUNT(*) FILTER (WHERE lt.type::text = 'deposit' AND lt.status = 'completed') AS deposit_count,
          COALESCE(SUM(CASE WHEN lt.type::text IN ${WAGER_TYPES_SQL} AND lt.status = 'completed' ${ledgerDateFilter}
            THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS wager_in_period,
          COALESCE(SUM(CASE WHEN lt.type::text IN ${PAYOUT_TYPES_SQL} AND lt.status = 'completed' ${ledgerDateFilter}
            THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS payouts_in_period
        FROM cohort c
        LEFT JOIN ledger_transactions lt ON lt.user_id = c.id
        GROUP BY c.id, c.affiliate_code, c.affiliate_user_id
      )
      SELECT
        code,
        affiliate_user_id,
        COUNT(*)::text AS signups,
        COUNT(*) FILTER (WHERE deposit_count > 0)::text AS first_deposit,
        COALESCE(SUM(wager_in_period - payouts_in_period), 0)::text AS ggr,
        COALESCE(SUM(wager_in_period), 0)::text AS wager
      FROM activity
      GROUP BY code, affiliate_user_id
      ORDER BY signups DESC
      LIMIT 25
    `);
  },
  ["insights-analytics-sources-codes-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

export async function getSourcesCodes(period: InsightsPeriod): Promise<SourceCodeRow[]> {
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);

  // Run the cached scan inside `safeQuery` (canonical heavy-read timeout,
  // empty fallback) so a slow/failed read degrades to an empty list
  // instead of pinning a MAIN pool slot and crashing the tab — the same
  // per-read resilience `getInsightsOverview` applies.
  const { data: rows } = await safeQuery(
    () => cachedSourcesCodes(period, blacklistIdNotIn),
    [] as SourceCodeRawRow[],
    "insights-analytics.sources.codes",
    REWARD_QUERY_TIMEOUT_MS,
  );

  return rows.map((r) => ({
    code: r.code,
    affiliateUserId: r.affiliate_user_id ?? null,
    signups: Number(r.signups),
    firstDeposit: Number(r.first_deposit),
    ggrDriven: toNumber(r.ggr),
    wagerDriven: toNumber(r.wager),
  }));
}
