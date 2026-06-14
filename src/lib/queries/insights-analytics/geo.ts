import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { periodToDays, type InsightsPeriod } from "./period";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";

/**
 * Geographic breakdown. Groups can be country (default), continent,
 * or state (limited to US for now — state column is sparsely populated
 * elsewhere).
 *
 * Per group we compute users, signups, deposits, wager, GGR, withdrawals.
 *
 * Period scopes deposits / wager / GGR / withdrawals only — `users` is
 * always the lifetime distinct count for the group (so admins can see
 * "we have N users from this country" alongside "they wagered $X in the
 * period").
 *
 * RESILIENCE + PERFORMANCE (mirrors `overview.ts` / `ltv.ts` in this
 * directory): the three parallel reads (lifetime users + per-period
 * ledger + per-period withdrawals) are heavy scans, run behind a
 * period/groupBy-keyed `unstable_cache` (300s, scope input in the key so a
 * changed blacklist can't serve a stale value, tagged `insights-analytics`
 * / `dashboard-lifetime`) and inside `safeQuery` with the canonical
 * heavy-read timeout so a slow/failed read degrades to an empty breakdown
 * instead of pinning a MAIN pool slot and crashing the tab.
 *
 * The per-period ledger + withdrawal scans bound the lifetime view to a
 * 365-day lookback (`GEO_LIFETIME_LOOKBACK_DAYS`) rather than the previous
 * unbounded `created_at` scan, consistent with `INSIGHTS_LIFETIME_LOOKBACK_DAYS`
 * (insights-rewards) and `overview.ts`. The `users` COUNT stays lifetime
 * (it is a `"user"`-table count, NOT a ledger scan, and is intentionally
 * the all-time group size — see the doc above).
 */

export type GeoGroupBy = "country" | "continent" | "state";

export function parseGeoGroupBy(value: string | undefined): GeoGroupBy {
  return value === "continent" || value === "state" ? value : "country";
}

export type GeoRow = {
  key: string;
  label: string;
  countryCode: string | null;
  users: number;
  signups: number;
  deposits: number;
  withdrawals: number;
  wager: number;
  ggr: number;
};

const WAGER_TYPES_SQL = `('pack_opening','battle_bet','battle_sponsorship','upgrader_bet')`;
const PAYOUT_TYPES_SQL = `('battle_refund','upgrader_payout','card_sale','reward_card_sale')`;

/**
 * Capped lookback (days) the lifetime ("lifetime" period) ledger +
 * withdrawal scans bound to instead of an unbounded `created_at` filter —
 * the unbounded-lifetime pattern CLAUDE.md forbids. 365d, matching
 * `INSIGHTS_LIFETIME_LOOKBACK_DAYS` (insights-rewards `_period.ts`) and
 * `overview.ts`'s `OVERVIEW_LIFETIME_LOOKBACK_DAYS`. Does NOT bound the
 * lifetime `users` group count (that is a `"user"`-table count, not a
 * ledger scan, and is intentionally all-time).
 */
const GEO_LIFETIME_LOOKBACK_DAYS = 365;

type GeoReads = {
  usersRows: { bucket: string; country_code: string | null; users: string; signups: string }[];
  ledgerRows: { bucket: string; deposits: string; wager: string; payouts: string }[];
  withdrawalRows: { bucket: string; amount: string }[];
};

const cachedGeoReads = unstable_cache(
  async (
    period: InsightsPeriod,
    groupBy: GeoGroupBy,
    blacklistIdNotIn: string,
  ): Promise<GeoReads> => {
    const db = await getDb();
    // Lifetime ("lifetime") resolves to the 365d cap (bounded), not null —
    // the period-scoped ledger / withdrawal scans never run unbounded. The
    // signups count is also bounded to the same window (it is a per-period
    // metric, unlike the lifetime `users` group count below).
    const days = periodToDays(period) ?? GEO_LIFETIME_LOOKBACK_DAYS;
    const periodFilter = `AND lt.created_at >= NOW() - INTERVAL '${days} days'`;
    const periodFilterSignups = `AND u.created_at >= NOW() - INTERVAL '${days} days'`;
    const withdrawalFilter = `AND COALESCE(cwr.completed_at, cwr.shipped_at) >= NOW() - INTERVAL '${days} days'`;

    // GroupExpr — country code uses (country, country_code) so the UI can
  // render the ISO code chip. Continent groups by continent_code.
  // State filters to US (state is mainly populated for US users).
  const groupExpr = (() => {
    switch (groupBy) {
      case "country":
        return "COALESCE(u.country, 'Unknown'), u.country_code";
      case "continent":
        return "u.continent_code, NULL::text";
      case "state":
        return "COALESCE(u.state, 'Unknown'), u.country_code";
    }
  })();

  const groupKeyExpr = (() => {
    switch (groupBy) {
      case "country":
        return "COALESCE(u.country, 'Unknown')";
      case "continent":
        return "u.continent_code";
      case "state":
        return "COALESCE(u.state, 'Unknown')";
    }
  })();

  const stateFilter = groupBy === "state" ? "AND u.country_code = 'US'" : "";

  // Three raws: users (lifetime), wager/ggr/deposits in period, withdrawals
  // in period. Joining them in code via a Map is cheaper than a single
  // monster query.
  const [usersRows, ledgerRows, withdrawalRows] = await Promise.all([
    db.$queryRawUnsafe<
      {
        bucket: string;
        country_code: string | null;
        users: string;
        signups: string;
      }[]
    >(`
      SELECT
        ${groupKeyExpr} AS bucket,
        MAX(u.country_code) AS country_code,
        COUNT(*)::text AS users,
        COUNT(*) FILTER (WHERE 1=1 ${periodFilterSignups.replace("AND ", "AND ")})::text AS signups
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
        ${stateFilter}
      GROUP BY ${groupExpr}
    `),
    db.$queryRawUnsafe<
      {
        bucket: string;
        deposits: string;
        wager: string;
        payouts: string;
      }[]
    >(`
      SELECT
        ${groupKeyExpr} AS bucket,
        COALESCE(SUM(CASE WHEN lt.type::text = 'deposit' THEN lt.amount::numeric ELSE 0 END), 0)::text AS deposits,
        COALESCE(SUM(CASE WHEN lt.type::text IN ${WAGER_TYPES_SQL} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS wager,
        COALESCE(SUM(CASE WHEN lt.type::text IN ${PAYOUT_TYPES_SQL} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS payouts
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
        ${stateFilter}
        ${periodFilter}
      GROUP BY ${groupKeyExpr}
    `),
    db.$queryRawUnsafe<
      {
        bucket: string;
        amount: string;
      }[]
    >(`
      SELECT
        ${groupKeyExpr} AS bucket,
        COALESCE(SUM(cwr.total_value_usd::numeric), 0)::text AS amount
      FROM card_withdrawal_requests cwr
      JOIN "user" u ON u.id = cwr.user_id
      WHERE cwr.status IN ('completed', 'shipped')
        AND u.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
        ${stateFilter}
        ${withdrawalFilter}
      GROUP BY ${groupKeyExpr}
    `),
    ]);

    return { usersRows, ledgerRows, withdrawalRows };
  },
  ["insights-analytics-geo-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

export async function getInsightsGeo(
  period: InsightsPeriod,
  groupBy: GeoGroupBy,
): Promise<{ rows: GeoRow[]; groupBy: GeoGroupBy }> {
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);

  // Run the cached heavy reads inside `safeQuery` (canonical heavy-read
  // timeout, empty fallback) so a slow/failed read degrades to an empty
  // breakdown instead of pinning a MAIN pool slot and crashing the tab —
  // the same per-read resilience `getInsightsOverview` applies.
  const { data } = await safeQuery(
    () => cachedGeoReads(period, groupBy, blacklistIdNotIn),
    {
      usersRows: [] as GeoReads["usersRows"],
      ledgerRows: [] as GeoReads["ledgerRows"],
      withdrawalRows: [] as GeoReads["withdrawalRows"],
    },
    "insights-analytics.geo",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const { usersRows, ledgerRows, withdrawalRows } = data;

  const byBucket = new Map<string, GeoRow>();
  for (const r of usersRows) {
    const bucket = r.bucket ?? "Unknown";
    byBucket.set(bucket, {
      key: bucket,
      label: bucket,
      countryCode: r.country_code ?? null,
      users: Number(r.users),
      signups: Number(r.signups),
      deposits: 0,
      withdrawals: 0,
      wager: 0,
      ggr: 0,
    });
  }
  for (const r of ledgerRows) {
    const bucket = r.bucket ?? "Unknown";
    const entry = byBucket.get(bucket);
    if (!entry) continue;
    entry.deposits = toNumber(r.deposits);
    entry.wager = toNumber(r.wager);
    entry.ggr = entry.wager - toNumber(r.payouts);
  }
  for (const r of withdrawalRows) {
    const bucket = r.bucket ?? "Unknown";
    const entry = byBucket.get(bucket);
    if (!entry) continue;
    entry.withdrawals = toNumber(r.amount);
  }

  const rows = Array.from(byBucket.values()).sort((a, b) => b.ggr - a.ggr);
  return { rows, groupBy };
}
