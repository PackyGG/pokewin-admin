import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import { resolveRainHouseCost } from "@/lib/metrics";
import {
  daysForInsightsPeriod,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "./_period";
import { windowDateFilterCapped } from "./deposit-bonus/_shared";

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

type RewardsRoiCategoryKey =
  | "bonuses"
  | "rakeback"
  | "affiliate"
  | "rainRace"
  | "signupPack"
  | "waitlist";

// Category-to-ledger-type map. Mirrors the canonical reward categories in
// `category-spend-breakdown.ts` so the page renders one ROI row per
// category in the same order as the spend breakdown. `creator_tip` is NOT
// a category — it is a RESIDUAL user→user pass-through, not a house reward
// cost. Rain is netted to its house slice (see `netRain` below).
const CATEGORIES: Array<{
  key: RewardsRoiCategoryKey;
  label: string;
  /** Reward-recipient ledger types (drive cost + claimant + forward GGR). */
  types: string[];
  /**
   * When true the category's COST is netted by the rain funding leg:
   * `cost = Σ|reward types| − Σ|rain_tip|`, floored at 0. Rain is
   * system-automatic + mixed-funded, so only the house slice
   * (`max(0, rain_win − rain_tip)`) is a real cost. Claimant + forward-GGR
   * still key on the actual reward recipients (rain_win / race_prize).
   */
  netRain?: boolean;
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
    netRain: true,
  },
  {
    key: "signupPack",
    label: "Signup / Balance Rewards",
    types: ["balance_reward_claim"],
  },
  { key: "waitlist", label: "Waitlist Prizes", types: ["waitlist_prize"] },
];

function typeListSql(types: readonly string[]): string {
  return `(${types.map((t) => `'${t}'`).join(",")})`;
}

export type RewardsRoiRow = {
  key: RewardsRoiCategoryKey;
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
  const blacklistJoin = blacklistNotInClause("u.id", blacklistIds);

  // Each category gets a CTE that picks the cost claimants + their
  // first in-window claim timestamp, then sweeps wager + payout sides
  // forward by `lookbackDays`. One round-trip per category keeps the
  // SQL small + readable; the cached wrapper amortises the N=7 cost.
  const rows = await Promise.all(
    CATEGORIES.map(async (cat) => {
      const typesSql = typeListSql(cat.types);
      // Lifetime (`days === null`) used to bound the forward sweep ONLY by
      // `>= claim_at`, so each claimant's full forward ledger history was
      // scanned with no upper/lower cap — the heaviest plan on this surface
      // and the one most likely to hang in prod. Mirror the deposit-bonus /
      // rakeback-ROI precedent (`windowDateFilterCapped`, bounds lifetime
      // scans to LIFETIME_PAIRING_LOOKBACK_DAYS=365): keep the `>= claim_at`
      // per-claimant forward floor and additionally bound the scan to the
      // last 365 days of ledger activity so a lifetime view never triggers a
      // full-history scan.
      const forwardWindowClause =
        days !== null
          ? `AND lt.created_at >= claim_at AND lt.created_at < claim_at + INTERVAL '${lookbackDays} days'`
          : `AND lt.created_at >= claim_at ${windowDateFilterCapped("all", "lt")}`;
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
            AND lt.type::text IN ${typesSql}
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
      const r = resultRows[0];
      const claimantCount = Number(r?.claimants ?? 0);
      const wager = toNumber(r?.wager);
      const payout = toNumber(r?.payout);

      // COST. For most categories this is the gross sum from
      // cost_claimants. For rain (netRain), the house slice is
      // `race_prize + max(0, rain_win − rain_tip)`: rain is mixed-funded,
      // so the user/founder tip contribution is netted out (the canonical
      // model). race_prize is NOT netted (it is fully house-funded). The
      // claimant + forward-GGR sweep above already keys on the real reward
      // recipients (rain_win / race_prize).
      let cost = toNumber(r?.cost);
      if (cat.netRain) {
        const rainRows = await db.$queryRawUnsafe<
          { race_prize: string; rain_win: string; rain_tip: string }[]
        >(`
          SELECT
            COALESCE(SUM(CASE WHEN lt.type::text = 'race_prize' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS race_prize,
            COALESCE(SUM(CASE WHEN lt.type::text = 'rain_win' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS rain_win,
            COALESCE(SUM(CASE WHEN lt.type::text = 'rain_tip' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS rain_tip
          FROM ledger_transactions lt
          JOIN "user" u ON u.id = lt.user_id
          WHERE lt.status = 'completed'
            AND lt.type::text IN ('race_prize','rain_win','rain_tip')
            AND u.role NOT IN ('admin', 'support') ${blacklistJoin}
            ${costDateClause}
        `);
        const rr = rainRows[0];
        const netRainCost = resolveRainHouseCost({
          kind: "net",
          rainWinTotal: toNumber(rr?.rain_win),
          rainTipTotal: toNumber(rr?.rain_tip),
        });
        cost = toNumber(rr?.race_prize) + netRainCost;
      }

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

  // Hide any category with $0 cost in the window — an empty reward line
  // never clutters the ROI table (general rule, consistent with the
  // category-spend breakdown). Waitlist Prizes drop out here when nothing
  // was paid.
  const visibleRows = rows.filter((r) => r.cost > 0);

  const totalCost = visibleRows.reduce((a, r) => a + r.cost, 0);
  // Blended figures sum only the visible (cost-bearing) categories so the
  // headline ROI denominator and the rendered rows describe the same set.
  const totalSubsequentGgr = visibleRows.reduce(
    (a, r) => a + r.subsequentGgr,
    0,
  );
  const blendedRoi = totalCost > 0 ? totalSubsequentGgr / totalCost : null;

  return {
    rows: visibleRows.sort((a, b) => b.cost - a.cost),
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
