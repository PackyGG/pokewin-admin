import { unstable_cache } from "next/cache";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import { getRaceInsightsROIFromClickHouse } from "@/lib/clickhouse/queries/insights-rewards/race/roi";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "../_period";

/**
 * Race-prize ROI for /insights/rewards/race.
 *
 * Mirrors the sibling cross-category `roi.ts` helper but narrows the
 * "cost" leg to race_prize ledger rows so we can answer "did races
 * generate net house revenue post-payout".
 *
 * Cost  = SUM(ABS(amount)) for ledger_transactions.type = 'race_prize'
 *         (status completed) in the active window
 * GGR   = SUM(wagers) − SUM(payouts) by the same claimants in the
 *         forward window (same lookback rules as cross-category ROI)
 *
 * Wager + payout types match `getGgrBreakdown` so the figure speaks
 * the dashboard's language:
 *   wagers  = pack_opening + battle_bet + battle_sponsorship + upgrader_bet
 *   payouts = battle_refund + upgrader_payout
 *
 * Output:
 *   - cost            — total race-prize $ paid in window
 *   - claimantCount   — distinct winners
 *   - subsequentGgr   — wagers − payouts (forward window)
 *   - roi             — subsequentGgr / cost (null when cost = 0)
 *   - avgGgrPerWinner — subsequentGgr / claimantCount
 *   - lookbackDays    — effective forward lookback used
 *
 * Staff + blacklist excluded. Cached per (period × lookback × blacklist).
 *
 * Per CLAUDE.md House-POV: roi > 0 → emerald (races drove enough wagers
 * to recoup the payout); roi < 0 → rose (house bled cost).
 */

const WAGER_TYPES_SQL = `(
  'pack_opening','battle_bet','battle_sponsorship','upgrader_bet'
)`;

const PAYOUT_TYPES_SQL = `('battle_refund','upgrader_payout')`;

export type RaceRoiResult = {
  cost: number;
  claimantCount: number;
  subsequentWager: number;
  subsequentPayout: number;
  subsequentGgr: number;
  roi: number | null;
  avgGgrPerWinner: number;
  lookbackDays: number;
};

/**
 * Resolve the forward lookback in days. Mirrors the cross-category
 * helper: short windows cap to the window itself; longer windows use
 * the caller-supplied value clamped to a sane range.
 */
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
): Promise<RaceRoiResult> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const lookbackDays = resolveLookback(period, rawLookbackDays);
  const costDateClause =
    days !== null
      ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'`
      : "";
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);
  const forwardWindowClause =
    days !== null
      ? `AND lt.created_at >= claim_at AND lt.created_at < claim_at + INTERVAL '${lookbackDays} days'`
      : `AND lt.created_at >= claim_at`;

  const rows = await db.$queryRawUnsafe<
    { cost: string; claimants: string; wager: string; payout: string }[]
  >(`
    WITH cost_claimants AS (
      SELECT
        lt.user_id,
        MIN(lt.created_at) AS claim_at,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS cost
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type::text = 'race_prize'
        AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
        ${costDateClause}
      GROUP BY lt.user_id
    ),
    forward_wagers AS (
      SELECT cc.user_id, COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS wager
      FROM cost_claimants cc
      JOIN ledger_transactions lt
        ON lt.user_id = cc.user_id
       AND lt.status = 'completed'
       AND lt.type::text IN ${WAGER_TYPES_SQL}
      WHERE 1=1 ${forwardWindowClause}
      GROUP BY cc.user_id
    ),
    forward_payouts AS (
      SELECT cc.user_id, COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS payout
      FROM cost_claimants cc
      JOIN ledger_transactions lt
        ON lt.user_id = cc.user_id
       AND lt.status = 'completed'
       AND lt.type::text IN ${PAYOUT_TYPES_SQL}
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
  const claimantCount = Number(r?.claimants ?? 0);
  const subsequentWager = toNumber(r?.wager);
  const subsequentPayout = toNumber(r?.payout);
  const subsequentGgr = subsequentWager - subsequentPayout;
  const roi = cost > 0 ? subsequentGgr / cost : null;
  const avgGgrPerWinner =
    claimantCount > 0 ? subsequentGgr / claimantCount : 0;
  return {
    cost,
    claimantCount,
    subsequentWager,
    subsequentPayout,
    subsequentGgr,
    roi,
    avgGgrPerWinner,
    lookbackDays,
  };
}

const cachedShort = unstable_cache(
  async (
    period: InsightsRewardsPeriod,
    lookbackDays: number,
    blacklistIds: string[],
  ) =>
    resolveAdminRead<RaceRoiResult>("insights_race_roi", {
      pg: () => computeRoi(period, lookbackDays, blacklistIds),
      ch: () =>
        getRaceInsightsROIFromClickHouse(period, lookbackDays, blacklistIds),
    }),
  ["insights-rewards-race-roi-v1"],
  { revalidate: 60, tags: ["insights-rewards-race"] },
);

const cachedLong = unstable_cache(
  async (
    period: InsightsRewardsPeriod,
    lookbackDays: number,
    blacklistIds: string[],
  ) =>
    resolveAdminRead<RaceRoiResult>("insights_race_roi", {
      pg: () => computeRoi(period, lookbackDays, blacklistIds),
      ch: () =>
        getRaceInsightsROIFromClickHouse(period, lookbackDays, blacklistIds),
    }),
  ["insights-rewards-race-roi-lifetime-v1"],
  { revalidate: 300, tags: ["insights-rewards-race"] },
);

export async function getRaceInsightsROI(
  period: InsightsRewardsPeriod,
  lookbackDays = 14,
): Promise<RaceRoiResult> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedLong(period, lookbackDays, sorted)
    : cachedShort(period, lookbackDays, sorted);
}
