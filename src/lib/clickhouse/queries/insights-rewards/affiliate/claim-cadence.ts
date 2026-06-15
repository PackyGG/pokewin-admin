import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import type { ClaimCadenceRow } from "@/lib/queries/insights-rewards/affiliate/claim-cadence";

import { CH_DB, chDateTime, toNumber } from "../../_shared";

/**
 * ClickHouse twin of `getAffiliateClaimCadence`
 * (`src/lib/queries/insights-rewards/affiliate/claim-cadence.ts`).
 *
 * PARITY: per-affiliate claim rhythm in the active window — claim count, total /
 * mean / median claim amount, mean / median gap (hours) between consecutive
 * claims. Top 25 by claim count (tie-break total commission), exactly like PG.
 * PG's `PERCENTILE_CONT(0.5)` (continuous linear interpolation) is reproduced
 * with `quantileExactWeightedInterpolated(0.5)(x, 1)` — verified value-identical
 * (even n → midpoint, odd n → middle value). PG's `LAG(created_at)` gap (NULL
 * for the first claim per user) is reproduced with `lagInFrame` + `row_number`
 * so the first claim contributes no gap.
 *
 * SCOPE (mirrors PG EXACTLY): admin/support only `role NOT IN ('admin','support')`
 * (creators KEPT) + blacklist on the affiliate `user.id`.
 *
 * COMPARISON NOTE: the compare hook diffs the row-set count + the money
 * aggregates (Σ claim count, Σ total commission, Σ mean amount, Σ median amount).
 * The GAP statistics (mean/median gap hours) are intentionally NOT asserted: a
 * gap is sensitive to the (undefined) ordering of equal-timestamp claims, which
 * each engine breaks independently — they are computed for shape fidelity but
 * would produce false drift, so they are excluded from the diff.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0`, money Decimal
 * (`toString(sum(...))`), `*If` combinators so single-claim affiliates yield a
 * NULL gap (no gap rows) exactly like PG.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const ROW_LIMIT = 25;

type Row = {
  affiliate_user_id: string;
  username: string | null;
  claim_count: string;
  total_commission: string;
  mean_amount: string;
  median_amount: string | null;
  mean_gap_hours: string | null;
  median_gap_hours: string | null;
};

export async function getAffiliateClaimCadenceFromClickHouse(
  period: InsightsRewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<ClaimCadenceRow[]> {
  const days = daysForInsightsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const params: Record<string, unknown> = { blacklist };
  let ltDate = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    ltDate = "AND lt.created_at >= {cutoff:DateTime64(6)}";
  }

  const rows = await clickhouseRead.query<Row>({
    queryName: "insights.affiliate.claim-cadence",
    sql: `
      WITH
        claim_rows AS (
          SELECT
            lt.user_id AS user_id,
            abs(lt.amount) AS amount,
            row_number() OVER w AS rn,
            (toUnixTimestamp64Micro(lt.created_at)
              - toUnixTimestamp64Micro(lagInFrame(lt.created_at) OVER w)) / 1000000.0 / 3600.0 AS gap_raw
          FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
          WHERE lt._peerdb_is_deleted = 0
            AND lt.status = 'completed'
            AND lt.type = 'affiliate_claim'
            ${ltDate}
          WINDOW w AS (PARTITION BY lt.user_id ORDER BY lt.created_at)
        ),
        per_user AS (
          SELECT
            user_id,
            count()                                                       AS claim_count,
            sum(amount)                                                   AS total_commission,
            avg(amount)                                                   AS mean_amount,
            quantileExactWeightedInterpolated(0.5)(amount, 1)             AS median_amount,
            avgIf(gap_raw, rn > 1)                                        AS mean_gap_hours,
            quantileExactWeightedInterpolatedIf(0.5)(gap_raw, 1, rn > 1)  AS median_gap_hours
          FROM claim_rows
          GROUP BY user_id
        )
      SELECT
        pu.user_id                       AS affiliate_user_id,
        u.username                       AS username,
        toString(pu.claim_count)         AS claim_count,
        toString(pu.total_commission)    AS total_commission,
        toString(pu.mean_amount)         AS mean_amount,
        toString(pu.median_amount)       AS median_amount,
        toString(pu.mean_gap_hours)      AS mean_gap_hours,
        toString(pu.median_gap_hours)    AS median_gap_hours
      FROM per_user AS pu
      INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = pu.user_id
      WHERE u._peerdb_is_deleted = 0
        AND u.role NOT IN ('admin','support')
        ${hasBlacklist ? "AND u.id NOT IN {blacklist:Array(String)}" : ""}
      ORDER BY pu.claim_count DESC, pu.total_commission DESC
      LIMIT ${ROW_LIMIT}`,
    params,
  });

  return rows.map((r) => ({
    affiliateUserId: r.affiliate_user_id,
    username: r.username,
    claimCount: Number(r.claim_count),
    totalCommission: toNumber(r.total_commission),
    meanClaimAmount: toNumber(r.mean_amount),
    medianClaimAmount: r.median_amount != null ? toNumber(r.median_amount) : 0,
    meanGapHours: r.mean_gap_hours != null ? toNumber(r.mean_gap_hours) : null,
    medianGapHours: r.median_gap_hours != null ? toNumber(r.median_gap_hours) : null,
  }));
}
