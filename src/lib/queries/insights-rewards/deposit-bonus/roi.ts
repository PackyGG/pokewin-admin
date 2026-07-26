import { queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import { unstable_cache } from "next/cache";
import { getDrizzleDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "../_period";
import {
  DEPOSIT_BONUS_CACHE_TAGS,
  getResolvedBlacklist,
  staffAndBlacklistSubquery,
  windowDateFilter,
} from "./_shared";

/**
 * Deposit-bonus ROI:
 *
 *   - cost in window           — sum of bonus payouts
 *   - subsequent GGR           — claimants' gameplay GGR (wager − payout)
 *                                 forward `lookbackDays` from each
 *                                 claimant's first in-window bonus claim
 *   - blendedRoi               — subsequentGgr / cost
 *   - per-claimant avg GGR     — for breakdown rendering
 *
 * Wager / payout sides match `getGgrBreakdown` so the ROI denominator
 * speaks the same language as the cross-category ROI page.
 *
 *   wagers  = pack_opening + battle_bet + battle_sponsorship + upgrader_bet
 *   payouts = battle_refund + upgrader_payout
 *
 * House-POV: positive ROI = emerald (house won the cost back); negative
 * ROI = rose (house bled cost without recouping).
 */

const WAGER_TYPES_SQL = `(
  'pack_opening','battle_bet','battle_sponsorship','upgrader_bet'
)`;
const PAYOUT_TYPES_SQL = `('battle_refund','upgrader_payout')`;

export type DepositBonusROI = {
  /** Total bonus cost in window. */
  cost: number;
  /** Distinct claimants in window. */
  claimants: number;
  /** Sum of wager-side ledger types in forward window for those claimants. */
  wager: number;
  /** Sum of payout-side ledger types in forward window. */
  payouts: number;
  /** wager − payouts. */
  subsequentGgr: number;
  /** subsequentGgr / cost; null when cost is 0. */
  blendedRoi: number | null;
  /** Avg GGR per claimant. */
  avgGgrPerClaimant: number;
  /** Effective lookback used in days. */
  effectiveLookbackDays: number;
};

function resolveLookback(
  period: InsightsRewardsPeriod,
  rawLookback: number,
): number {
  if (period === "24h") return 1;
  if (period === "3d") return 3;
  return Math.max(1, Math.min(rawLookback, 180));
}

async function computeRoi(
  period: InsightsRewardsPeriod,
  rawLookbackDays: number,
  blacklistIds: string[],
): Promise<DepositBonusROI> {
  const db = await getDrizzleDb();
  const days = daysForInsightsPeriod(period);
  const lookbackDays = resolveLookback(period, rawLookbackDays);
  const costDateClause = windowDateFilter(period);
  const userScope = staffAndBlacklistSubquery(blacklistIds);
  const forwardWindowClause =
    days !== null
      ? sql`AND lt.created_at >= claim_at
            AND lt.created_at < claim_at + (${lookbackDays} * INTERVAL '1 day')`
      : sql`AND lt.created_at >= claim_at`;

  const rows = await queryRows<
    {
      cost: string;
      claimants: string;
      wager: string;
      payout: string;
    }[]
  >(db, sql`
    WITH cost_claimants AS (
      SELECT
        lt.user_id,
        MIN(lt.created_at) AS claim_at,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS cost
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text = 'deposit_bonus'
        AND lt.user_id IN ${userScope}
        ${costDateClause}
      GROUP BY lt.user_id
    ),
    forward_wagers AS (
      SELECT cc.user_id, COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS wager
      FROM cost_claimants cc
      JOIN ledger_transactions lt
        ON lt.user_id = cc.user_id
       AND lt.status = 'completed'
       AND lt.type::text IN ${sql.raw(WAGER_TYPES_SQL)}
      WHERE 1=1 ${forwardWindowClause}
      GROUP BY cc.user_id
    ),
    forward_payouts AS (
      SELECT cc.user_id, COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS payout
      FROM cost_claimants cc
      JOIN ledger_transactions lt
        ON lt.user_id = cc.user_id
       AND lt.status = 'completed'
       AND lt.type::text IN ${sql.raw(PAYOUT_TYPES_SQL)}
      WHERE 1=1 ${forwardWindowClause}
      GROUP BY cc.user_id
    )
    SELECT
      COALESCE(SUM(cc.cost), 0)::text AS cost,
      COUNT(*)::text AS claimants,
      COALESCE(SUM(fw.wager), 0)::text AS wager,
      COALESCE(SUM(fp.payout), 0)::text AS payout
    FROM cost_claimants cc
    LEFT JOIN forward_wagers fw ON fw.user_id = cc.user_id
    LEFT JOIN forward_payouts fp ON fp.user_id = cc.user_id
  `);

  const r = rows[0];
  const cost = toNumber(r?.cost);
  const claimants = Number(r?.claimants ?? 0);
  const wager = toNumber(r?.wager);
  const payouts = toNumber(r?.payout);
  const subsequentGgr = wager - payouts;
  const blendedRoi = cost > 0 ? subsequentGgr / cost : null;
  const avgGgrPerClaimant = claimants > 0 ? subsequentGgr / claimants : 0;

  return {
    cost,
    claimants,
    wager,
    payouts,
    subsequentGgr,
    blendedRoi,
    avgGgrPerClaimant,
    effectiveLookbackDays: lookbackDays,
  };
}

const cachedRoi = unstable_cache(
  async (
    period: InsightsRewardsPeriod,
    lookbackDays: number,
    blacklistIds: string[],
  ) => computeRoi(period, lookbackDays, blacklistIds),
  ["insights-rewards-deposit-bonus-roi-v1"],
  { revalidate: 300, tags: [...DEPOSIT_BONUS_CACHE_TAGS] },
);

export async function getDepositBonusROI(
  period: InsightsRewardsPeriod,
  lookbackDays = 14,
): Promise<DepositBonusROI> {
  const blacklist = await getResolvedBlacklist();
  return cachedRoi(period, lookbackDays, blacklist);
}
