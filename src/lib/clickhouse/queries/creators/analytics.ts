import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import type { AffiliateAnalyticsData } from "@/lib/queries/creators-types";

import { CH_DB, chDateTime, toNumber } from "../_shared";

/**
 * ClickHouse twin of `getAffiliateAnalytics` (`src/lib/queries/creators-analytics.ts`)
 * — the /creators/analytics affiliate-performance surface (Phase 2B). Returns
 * the SAME `AffiliateAnalyticsData` shape (headline scalars + per-day series).
 *
 * PARITY with the canonical Postgres definition (mirrored EXACTLY):
 *
 *   • totalSignups       — COUNT affiliate_code_usages where usage_type='signup',
 *                          referred_user_id in scope, created in window.
 *   • totalCommissionPaid— SUM affiliate_payouts.amount_usd where status='paid',
 *                          created in window. NO referred scope (matches PG).
 *   • totalWagerVolume   — SUM affiliate_code_usages.wager_amount_usd, scope+window.
 *   • totalDepositVolume — SUM affiliate_code_usages.deposit_amount_usd, scope+window.
 *   • totalClicks        — COUNT affiliate_clicks in window. NO scope (matches PG).
 *   • activeCreators     — COUNT affiliate_accounts joined to a user with
 *                          role='creator' AND affiliate_code_active=true. NO window.
 *   • daily              — per-UTC-day signups / commission / wager / deposit
 *                          (from affiliate_code_usages, scope+window) merged with
 *                          per-day clicks (from affiliate_clicks, window only),
 *                          same merge + sort as the PG twin.
 *
 * SCOPE (mirrors the PG twin EXACTLY — NOT the wholesale customer scope):
 *   `referred_user_id IN (SELECT id FROM "user" WHERE role NOT IN
 *   ('admin','support') [AND id NOT IN <blacklist>])` — the
 *   `realCustomerIdsSubquery` 2-role scope. Creators are KEPT (this surface is
 *   ABOUT creators/affiliates), so `customerScopeCte` (which also drops
 *   creators) is deliberately NOT used. The scope only filters the three
 *   `affiliate_code_usages` reads; payouts, clicks, and the active-creator count
 *   carry no referred-scope filter, exactly like Postgres.
 *
 * Window cutoff reuses the SAME interval semantics the PG path uses
 * (`NOW() - INTERVAL 'N days'`), applied to a single caller-supplied `now` so a
 * parity harness can feed both engines a byte-identical cutoff (prod runs UTC,
 * so an N-day interval is exactly N*24h). `all` = no lower bound.
 *
 * ClickHouse correctness (PeerDB / ReplacingMergeTree mirrors): dedup latest row
 * per id with FINAL, drop soft-deleted rows with `_peerdb_is_deleted = 0`, money
 * stays Decimal end-to-end (`toString(sum(...))` in SQL → `toNumber()` in TS,
 * never Float). The blacklist is passed IN by the caller so this module never
 * imports a Postgres/Prisma client — it is a pure ClickHouse read.
 */

type Period = "today" | "7d" | "30d" | "90d" | "all";

const PERIOD_DAYS: Record<Exclude<Period, "all">, number> = {
  today: 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

function periodToSince(period: Period, now: Date): Date | null {
  if (period === "all") return null;
  return new Date(now.getTime() - PERIOD_DAYS[period] * 24 * 60 * 60 * 1000);
}

/**
 * The referred-user scope CTE — 2-role exclusion (admin/support only; creators
 * KEPT) + the excluded-users blacklist when present. Mirrors
 * `realCustomerIdsSubquery` applied to `referred_user_id`.
 */
function realUsersCte(hasBlacklist: boolean): string {
  return `real_users AS (
      SELECT id
      FROM ${CH_DB}.public_user FINAL
      WHERE _peerdb_is_deleted = 0
        AND role NOT IN ('admin','support')
        ${hasBlacklist ? "AND id NOT IN {blacklist:Array(String)}" : ""}
    )`;
}

type CountRow = { count: string };
type PayoutRow = { total: string };
type UsageRow = { wager: string; deposit: string };
type DailyUsageRow = {
  date: string;
  signups: string;
  wager: string;
  deposit: string;
  commission: string;
};
type DailyClickRow = { date: string; clicks: string };

export async function getAffiliateAnalyticsFromClickHouse(
  period: Period,
  blacklist: string[],
  now: Date = new Date(),
): Promise<AffiliateAnalyticsData> {
  const since = periodToSince(period, now);
  const hasBlacklist = blacklist.length > 0;
  const cutoff = since === null ? undefined : chDateTime(since);

  const params: Record<string, unknown> = { blacklist };
  if (cutoff !== undefined) params.cutoff = cutoff;

  const sinceUsage =
    since === null ? "" : "AND acu.created_at >= {cutoff:DateTime64(6)}";
  const sincePayout =
    since === null ? "" : "AND ap.created_at >= {cutoff:DateTime64(6)}";
  const sinceClick =
    since === null ? "" : "AND ac.created_at >= {cutoff:DateTime64(6)}";

  const scopeCte = realUsersCte(hasBlacklist);
  const referredFilter = "AND acu.referred_user_id IN (SELECT id FROM real_users)";

  const [
    signupsRows,
    payoutsRows,
    usagesRows,
    clicksRows,
    activeRows,
    dailyUsageRows,
    dailyClickRows,
  ] = await Promise.all([
    clickhouseRead.query<CountRow>({
      queryName: "creators.analytics.signups",
      sql: `
        WITH ${scopeCte}
        SELECT toString(count()) AS count
        FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
        WHERE acu._peerdb_is_deleted = 0
          AND acu.usage_type = 'signup'
          ${referredFilter}
          ${sinceUsage}`,
      params,
    }),
    clickhouseRead.query<PayoutRow>({
      queryName: "creators.analytics.payouts",
      sql: `
        SELECT toString(sum(ap.amount_usd)) AS total
        FROM ${CH_DB}.public_affiliate_payouts AS ap FINAL
        WHERE ap._peerdb_is_deleted = 0
          AND ap.status = 'paid'
          ${sincePayout}`,
      params,
    }),
    clickhouseRead.query<UsageRow>({
      queryName: "creators.analytics.usages",
      sql: `
        WITH ${scopeCte}
        SELECT
          toString(sum(acu.wager_amount_usd))   AS wager,
          toString(sum(acu.deposit_amount_usd)) AS deposit
        FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
        WHERE acu._peerdb_is_deleted = 0
          ${referredFilter}
          ${sinceUsage}`,
      params,
    }),
    clickhouseRead.query<CountRow>({
      queryName: "creators.analytics.clicks",
      sql: `
        SELECT toString(count()) AS count
        FROM ${CH_DB}.public_affiliate_clicks AS ac FINAL
        WHERE ac._peerdb_is_deleted = 0
          ${sinceClick}`,
      params,
    }),
    clickhouseRead.query<CountRow>({
      queryName: "creators.analytics.active_creators",
      sql: `
        SELECT toString(count()) AS count
        FROM ${CH_DB}.public_affiliate_accounts AS aa FINAL
        INNER JOIN ${CH_DB}.public_user AS u FINAL
          ON u.id = aa.user_id AND u._peerdb_is_deleted = 0
        WHERE aa._peerdb_is_deleted = 0
          AND u.role = 'creator'
          AND u.affiliate_code_active = true`,
      params,
    }),
    clickhouseRead.query<DailyUsageRow>({
      queryName: "creators.analytics.daily_usages",
      sql: `
        WITH ${scopeCte}
        SELECT
          toString(toDate(acu.created_at)) AS date,
          toString(countIf(acu.usage_type = 'signup')) AS signups,
          toString(sum(acu.wager_amount_usd))   AS wager,
          toString(sum(acu.deposit_amount_usd)) AS deposit,
          toString(sum(acu.referrer_cut_usd))   AS commission
        FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
        WHERE acu._peerdb_is_deleted = 0
          ${referredFilter}
          ${sinceUsage}
        GROUP BY toDate(acu.created_at)
        ORDER BY date`,
      params,
    }),
    clickhouseRead.query<DailyClickRow>({
      queryName: "creators.analytics.daily_clicks",
      sql: `
        SELECT
          toString(toDate(ac.created_at)) AS date,
          toString(count()) AS clicks
        FROM ${CH_DB}.public_affiliate_clicks AS ac FINAL
        WHERE ac._peerdb_is_deleted = 0
          ${sinceClick}
        GROUP BY toDate(ac.created_at)
        ORDER BY date`,
      params,
    }),
  ]);

  const clicksMap = new Map<string, number>(
    dailyClickRows.map((d) => [String(d.date).slice(0, 10), Number(d.clicks)]),
  );

  const daily = dailyUsageRows.map((d) => {
    const dateStr = String(d.date).slice(0, 10);
    return {
      date: dateStr,
      signups: Number(d.signups),
      commission: toNumber(d.commission),
      wagerVolume: toNumber(d.wager),
      depositVolume: toNumber(d.deposit),
      clicks: clicksMap.get(dateStr) ?? 0,
    };
  });

  for (const [dateStr, clicks] of clicksMap) {
    if (!daily.find((d) => d.date === dateStr)) {
      daily.push({
        date: dateStr,
        signups: 0,
        commission: 0,
        wagerVolume: 0,
        depositVolume: 0,
        clicks,
      });
    }
  }
  daily.sort((a, b) => a.date.localeCompare(b.date));

  return {
    totalSignups: Number(signupsRows[0]?.count ?? 0),
    totalCommissionPaid: toNumber(payoutsRows[0]?.total),
    totalWagerVolume: toNumber(usagesRows[0]?.wager),
    totalDepositVolume: toNumber(usagesRows[0]?.deposit),
    totalClicks: Number(clicksRows[0]?.count ?? 0),
    activeCreators: Number(activeRows[0]?.count ?? 0),
    daily,
  };
}
