import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type {
  AffiliateGeoBreakdown,
  AffiliateGeoRow,
  ReferredGeoRow,
} from "@/lib/queries/insights-rewards/affiliate/geo";

import { CH_DB, chDateTime, toNumber } from "../../_shared";

/**
 * ClickHouse twin of `getAffiliateGeoBreakdown`
 * (`src/lib/queries/insights-rewards/affiliate/geo.ts`).
 *
 * PARITY: two side-by-side top-12 country breakdowns — affiliate-side commission
 * (`affiliate_claim` ledger joined to the affiliate `user`) and referred-side
 * downstream wager (`affiliate_code_usages` joined to the referred `user`). NULL
 * `country_code` collapses to '??'. The grand totals + share % are derived in TS
 * off the visible buckets, identical to PG.
 *
 * SCOPE (mirrors PG EXACTLY): admin/support only `role NOT IN ('admin','support')`
 * (creators KEPT) + blacklist on the joined `user.id` — on BOTH sides (affiliate
 * user for commission, referred user for wager).
 *
 * NOTE: `ORDER BY sum(...) DESC LIMIT 12` has no secondary tiebreaker on either
 * engine; the compare hook diffs the grand totals + summed visible-bucket totals,
 * stable whenever the top-12 bucket sums are distinct.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0` on every mirror table,
 * `uniqExact` for distinct counts, money Decimal (`toString(sum(...))`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const COUNTRY_LIMIT = 12;

type AffRow = { code: string; affiliates: string; commission: string };
type RefRow = { code: string; referred_users: string; wager: string };

export async function getAffiliateGeoBreakdownFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<AffiliateGeoBreakdown> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };
  let ltDate = "";
  let acuDate = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    ltDate = "AND lt.created_at >= {cutoff:DateTime64(6)}";
    acuDate = "AND acu.created_at >= {cutoff:DateTime64(6)}";
  }
  const blacklistClause = hasBlacklist
    ? "AND u.id NOT IN {blacklist:Array(String)}"
    : "";

  const [affRows, refRows] = await Promise.all([
    clickhouseRead.query<AffRow>({
      queryName: "insights.affiliate.geo.affiliate",
      sql: `
        SELECT
          coalesce(u.country_code, '??')    AS code,
          toString(uniqExact(lt.user_id))   AS affiliates,
          toString(sum(abs(lt.amount)))     AS commission
        FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
        INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = lt.user_id
        WHERE lt._peerdb_is_deleted = 0
          AND u._peerdb_is_deleted = 0
          AND lt.status = 'completed'
          AND lt.type = 'affiliate_claim'
          AND u.role NOT IN ('admin','support')
          ${blacklistClause}
          ${ltDate}
        GROUP BY coalesce(u.country_code, '??')
        ORDER BY sum(abs(lt.amount)) DESC
        LIMIT ${COUNTRY_LIMIT}`,
      params,
    }),
    clickhouseRead.query<RefRow>({
      queryName: "insights.affiliate.geo.referred",
      sql: `
        SELECT
          coalesce(u.country_code, '??')          AS code,
          toString(uniqExact(acu.referred_user_id)) AS referred_users,
          toString(sum(acu.wager_amount_usd))     AS wager
        FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
        INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = acu.referred_user_id
        WHERE acu._peerdb_is_deleted = 0
          AND u._peerdb_is_deleted = 0
          AND acu.status = 'completed'
          AND u.role NOT IN ('admin','support')
          ${blacklistClause}
          ${acuDate}
        GROUP BY coalesce(u.country_code, '??')
        ORDER BY sum(acu.wager_amount_usd) DESC
        LIMIT ${COUNTRY_LIMIT}`,
      params,
    }),
  ]);

  const totalCommission = affRows.reduce((a, r) => a + toNumber(r.commission), 0);
  const totalDownstreamWager = refRows.reduce((a, r) => a + toNumber(r.wager), 0);

  const affiliateGeo: AffiliateGeoRow[] = affRows.map((r) => {
    const commission = toNumber(r.commission);
    return {
      code: r.code,
      affiliateCount: Number(r.affiliates),
      commission,
      share: totalCommission > 0 ? (commission / totalCommission) * 100 : 0,
    };
  });
  const referredGeo: ReferredGeoRow[] = refRows.map((r) => {
    const wager = toNumber(r.wager);
    return {
      code: r.code,
      referredUserCount: Number(r.referred_users),
      downstreamWager: wager,
      share: totalDownstreamWager > 0 ? (wager / totalDownstreamWager) * 100 : 0,
    };
  });

  return { affiliateGeo, referredGeo, totalCommission, totalDownstreamWager };
}
