import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "./_period";

/**
 * ROI analysis per reward category — for every category, compare:
 *
 *   - cost in window          : reward $ paid to claimants
 *   - subsequent GGR          : claimants' gameplay GGR (wagers minus
 *                               payouts) in the trailing lookback days
 *                               *after* their first claim in the window
 *
 * "Did this bonus pay off?" → ROI = subsequentGgr / cost.
 *
 * Lifetime windows compare against full forward history of claimants;
 * finite windows look forward `lookbackDays` from each claimant's first
 * in-window claim. The page's default lookback is 14 days so a $5 bonus
 * paid out 14 days ago gets a fair window to recoup. Short windows
 * (24h / 3d) override the lookback to the period itself so the math
 * stays bounded.
 *
 * Wager / payout sides match `getGgrBreakdown` so the ROI denominator
 * speaks the same language as the dashboard:
 *
 *   wagers  = pack_opening + battle_bet + battle_sponsorship + upgrader_bet
 *   payouts = battle_refund + upgrader_payout
 *
 * Per CLAUDE.md House-POV: positive ROI = emerald (house won); negative
 * ROI = rose (house bled cost without recouping). The component
 * decides colour from the sign at render time.
 *
 * Staff + blacklist excluded. Read-only. Cached per (period × lookback
 * × blacklist).
 */

const WAGER_TYPES_SQL = `(
  'pack_opening','battle_bet','battle_sponsorship','upgrader_bet'
)`;

const PAYOUT_TYPES_SQL = `('battle_refund','upgrader_payout')`;

// Category-to-ledger-type map. Same key set as
// `category-spend-breakdown.ts` so the page renders one ROI row per
// category in the same order as the spend breakdown.
const CATEGORIES: Array<{
  key:
    | "bonuses"
    | "rakeback"
    | "affiliate"
    | "rainRace"
    | "signupPack"
    | "creatorTip"
    | "waitlist";
  label: string;
  types: string[];
}> = [
  {
    key: "bonuses",
    label: "Bonuses & Promos",
    types: ["deposit_bonus", "promo_code_redeemed", "gift_card_redeemed"],
  },
  { key: "rakeback", label: "Rakeback", types: ["rakeback_claim"] },
  {
    key: "affiliate",
    label: "Affiliate Commissions",
    types: ["affiliate_claim"],
  },
  {
    key: "rainRace",
    label: "Rain / Race Prizes",
    types: ["rain_win", "race_prize"],
  },
  {
    key: "signupPack",
    label: "Signup / Balance Rewards",
    types: ["balance_reward_claim"],
  },
  { key: "creatorTip", label: "Creator Tips", types: ["creator_tip"] },
  { key: "waitlist", label: "Waitlist Prizes", types: ["waitlist_prize"] },
];

function typeListSql(types: readonly string[]): string {
  return `(${types.map((t) => `'${t}'`).join(",")})`;
}

export type RewardsRoiRow = {
  key:
    | "bonuses"
    | "rakeback"
    | "affiliate"
    | "rainRace"
    | "signupPack"
    | "creatorTip"
    | "waitlist";
  label: string;
  /** Total reward $ paid to claimants in the cost window. */
  cost: number;
  /** Distinct claimants in the cost window. */
  claimantCount: number;
  /** Claimants' gameplay GGR after first in-window claim, summed. */
  subsequentGgr: number;
  /**
   * ROI = subsequentGgr / cost. `null` when cost is 0. House-POV:
   *   - > 0  : house ahead (emerald)
   *   - < 0  : house behind (rose) — happens when claimants won big
   *           post-claim
   *   - = 0  : even
   */
  roi: number | null;
  /** Average GGR per claimant in the forward lookback. */
  avgGgrPerClaimant: number;
};

export type RewardsRoiResult = {
  rows: RewardsRoiRow[];
  /** Sum cost across categories — equals overview totalCost. */
  totalCost: number;
  /** Sum GGR contribution across category claimants. */
  totalSubsequentGgr: number;
  /** Blended ROI = totalSubsequentGgr / totalCost. `null` when totalCost = 0. */
  blendedRoi: number | null;
  /** Effective forward lookback used in days. Always present. */
  effectiveLookbackDays: number;
};

/**
 * Resolve the forward lookback in days. The page exposes a default of
 * 14 days which works well for finite windows ≥ 7d. Shorter windows
 * (24h / 3d) cap the lookback to the window itself so the math stays
 * bounded and doesn't try to peek past NOW. Lifetime keeps the caller's
 * lookback unless it's null (then it falls back to a generous 30d).
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
): Promise<RewardsRoiResult> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const lookbackDays = resolveLookback(period, rawLookbackDays);
  const costDateClause =
    days !== null
      ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'`
      : "";
  const blacklistSubquery = blacklistNotInClause("id", blacklistIds);
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // Each category gets a CTE that picks the cost claimants + their
  // first in-window claim timestamp, then sweeps wager + payout sides
  // forward by `lookbackDays`. One round-trip per category keeps the
  // SQL small + readable; the cached wrapper amortises the N=7 cost.
  const rows = await Promise.all(
    CATEGORIES.map(async (cat) => {
      const typesSql = typeListSql(cat.types);
      const forwardWindowClause =
        days !== null
          ? `AND lt.created_at >= claim_at AND lt.created_at < claim_at + INTERVAL '${lookbackDays} days'`
          : `AND lt.created_at >= claim_at`;
      const resultRows = await db.$queryRawUnsafe<
        {
          cost: string;
          claimants: string;
          wager: string;
          payout: string;
        }[]
      >(`
        WITH cost_claimants AS (
          SELECT
            lt.user_id,
            MIN(lt.created_at) AS claim_at,
            COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS cost
          FROM ledger_transactions lt
          JOIN "user" u ON u.id = lt.user_id
          WHERE lt.status = 'completed'
            AND lt.type IN ${typesSql}
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
           AND lt.type IN ${WAGER_TYPES_SQL}
          WHERE 1=1 ${forwardWindowClause}
          GROUP BY cc.user_id
        ),
        forward_payouts AS (
          SELECT cc.user_id, COALESCE(SUM(ABS(lt.amount::numeric)), 0) AS payout
          FROM cost_claimants cc
          JOIN ledger_transactions lt
            ON lt.user_id = cc.user_id
           AND lt.status = 'completed'
           AND lt.type IN ${PAYOUT_TYPES_SQL}
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
      const r = resultRows[0];
      const cost = toNumber(r?.cost);
      const claimantCount = Number(r?.claimants ?? 0);
      const wager = toNumber(r?.wager);
      const payout = toNumber(r?.payout);
      const subsequentGgr = wager - payout;
      const roi = cost > 0 ? subsequentGgr / cost : null;
      const avgGgrPerClaimant =
        claimantCount > 0 ? subsequentGgr / claimantCount : 0;
      return {
        key: cat.key,
        label: cat.label,
        cost,
        claimantCount,
        subsequentGgr,
        roi,
        avgGgrPerClaimant,
      };
    }),
  );

  const totalCost = rows.reduce((a, r) => a + r.cost, 0);
  const totalSubsequentGgr = rows.reduce((a, r) => a + r.subsequentGgr, 0);
  const blendedRoi = totalCost > 0 ? totalSubsequentGgr / totalCost : null;

  return {
    rows: rows.sort((a, b) => b.cost - a.cost),
    totalCost,
    totalSubsequentGgr,
    blendedRoi,
    effectiveLookbackDays: lookbackDays,
  };
}

const cachedRoi = unstable_cache(
  async (
    period: InsightsRewardsPeriod,
    lookbackDays: number,
    blacklistIds: string[],
  ) => computeRoi(period, lookbackDays, blacklistIds),
  ["insights-rewards-roi-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards"] },
);

const cachedRoiLifetime = unstable_cache(
  async (
    period: InsightsRewardsPeriod,
    lookbackDays: number,
    blacklistIds: string[],
  ) => computeRoi(period, lookbackDays, blacklistIds),
  ["insights-rewards-roi-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards"] },
);

export async function getRewardsROI(
  period: InsightsRewardsPeriod,
  lookbackDays = 14,
): Promise<RewardsRoiResult> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedRoiLifetime(period, lookbackDays, sorted)
    : cachedRoi(period, lookbackDays, sorted);
}
