import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { TopAffiliateByWager } from "@/lib/queries/insights-rewards/affiliate/leaderboards";

import { CH_DB, chDateTime, toNumber } from "../../_shared";

/**
 * ClickHouse twin of `getTopAffiliatesByWager`
 * (`src/lib/queries/insights-rewards/affiliate/leaderboards.ts`).
 *
 * (Only the wager leaderboard is mirrored: `getTopAffiliatesByCommission` is not
 * rendered on the page or the export, so it has no comparison render path.)
 *
 * PARITY: top 25 affiliates by downstream cohort wager in the active window
 * (`affiliate_code_usages`), each paired with their commission paid in the same
 * window (`affiliate_claim` ledger) via a LEFT JOIN. Only affiliates with wager
 * > 0 qualify, exactly like PG.
 *
 * SCOPE (mirrors PG EXACTLY): WHOLESALE customer scope on the affiliate `user`
 * `role NOT IN ('admin','support','creator')` (creators dropped) + blacklist on
 * `user.id`. The usage + claim aggregates themselves are unscoped by role (PG
 * only scopes the joined affiliate user), so they are left unscoped here too.
 *
 * NOTE: `ORDER BY wager DESC LIMIT 25` has no secondary tiebreaker on either
 * engine; the compare hook diffs the leaderboard AGGREGATE (Σ wager, Σ
 * commission, Σ referred, row count), stable whenever the top-25 wager sums are
 * distinct.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0`, `uniqExact` for distinct
 * referred-user counts, money Decimal (`toString(sum(...))`, scale-matched
 * `toDecimal128(0, 2)` zero-branch), `join_use_nulls = 1` so an unmatched
 * commission LEFT JOIN yields a proper zero.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const TOP_LIMIT = 25;

type Row = {
  affiliate_user_id: string;
  username: string | null;
  wager: string;
  referred_count: string;
  commission: string;
};

export async function getTopAffiliatesByWagerFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<TopAffiliateByWager[]> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };
  let acuDate = "";
  let ltDate = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    acuDate = "AND acu.created_at >= {cutoff:DateTime64(6)}";
    ltDate = "AND lt.created_at >= {cutoff:DateTime64(6)}";
  }

  const rows = await clickhouseRead.query<Row>({
    queryName: "insights.affiliate.top-wager",
    sql: `
      WITH
        wager_agg AS (
          SELECT
            acu.affiliate_user_id              AS affiliate_user_id,
            sum(acu.wager_amount_usd)          AS wager,
            uniqExact(acu.referred_user_id)    AS referred_count
          FROM ${CH_DB}.public_affiliate_code_usages AS acu FINAL
          WHERE acu._peerdb_is_deleted = 0
            AND acu.status = 'completed'
            ${acuDate}
          GROUP BY acu.affiliate_user_id
        ),
        claim_agg AS (
          SELECT
            lt.user_id            AS user_id,
            sum(abs(lt.amount))   AS commission
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'affiliate_claim'
            ${ltDate}
          GROUP BY lt.user_id
        )
      SELECT
        wa.affiliate_user_id                                  AS affiliate_user_id,
        u.username                                            AS username,
        toString(wa.wager)                                    AS wager,
        toString(wa.referred_count)                           AS referred_count,
        toString(coalesce(ca.commission, toDecimal128(0, 2))) AS commission
      FROM wager_agg AS wa
      INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = wa.affiliate_user_id
      LEFT JOIN claim_agg AS ca ON ca.user_id = wa.affiliate_user_id
      WHERE u._peerdb_is_deleted = 0
        AND u.role NOT IN ('admin','support','creator')
        ${hasBlacklist ? "AND u.id NOT IN {blacklist:Array(String)}" : ""}
        AND wa.wager > 0
      ORDER BY wa.wager DESC
      LIMIT ${TOP_LIMIT}
      SETTINGS join_use_nulls = 1`,
    params,
  });

  return rows.map((r) => ({
    affiliateUserId: r.affiliate_user_id,
    username: r.username,
    referredWager: toNumber(r.wager),
    referredCount: Number(r.referred_count),
    commissionPaid: toNumber(r.commission),
  }));
}
