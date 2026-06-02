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
import { getDailyPacksTotalCost } from "./daily-packs";

/**
 * Cross-category rollup powering the Overview tab of /insights/rewards.
 *
 * The Overview tab wants the one-glance top-line:
 *   - Total marketing cost (every reward ledger row, all categories
 *     combined) for the active window.
 *   - Active claimant count (distinct users who received at least one
 *     reward in the window).
 *   - Payouts count.
 *   - GGR for the same window (so the ROI ratio is well-defined).
 *   - Marketing cost as % of GGR.
 *   - Marketing cost as % of total wager.
 *   - Period-over-period deltas vs the prior equal window (only for
 *     finite windows — lifetime has no "prior" frame).
 *
 * Reward ledger types come from the same canonical list used in
 * `rewards-analytics.ts`. Vouchers are deliberately excluded — they
 * live in a separate view per the existing convention. Wager + payout
 * sides for GGR follow the dashboard breakdown:
 *
 *   wagers   = pack_opening + battle_bet + battle_sponsorship + upgrader_bet
 *   payouts  = battle_refund + upgrader_payout
 *
 * (Same shape as `getGgrBreakdown` in `dashboard.ts`. Reward-side
 * payouts like rakeback / deposit_bonus deliberately stay out of GGR
 * since those are marketing spend, not gameplay payouts — admins want
 * the ratio "marketing spend / pure gameplay profit", which is what
 * GGR gives.)
 *
 * Staff + blacklist excluded. Period-aware. Read-only sweep over
 * ledger_transactions, indexed via the existing user_id + type
 * indexes.
 */

const REWARD_TYPES_SQL = `(
  'deposit_bonus','promo_code_redeemed','gift_card_redeemed',
  'rakeback_claim','affiliate_claim',
  'rain_win','race_prize','balance_reward_claim','creator_tip',
  'waitlist_prize'
)`;

const WAGER_TYPES_SQL = `(
  'pack_opening','battle_bet','battle_sponsorship','upgrader_bet'
)`;

const PAYOUT_TYPES_SQL = `('battle_refund','upgrader_payout')`;

export type RewardsCrossCategorySummary = {
  /**
   * Total marketing cost in the window: ABS(amount) across every reward
   * ledger type PLUS the daily / free pack giveaway cost (value of cards
   * handed out from `pack_type='reward'` opens, which book no ledger row).
   */
  totalCost: number;
  /**
   * Payout count in the window: reward ledger row count PLUS daily/free
   * pack opens (each open is one giveaway payout event).
   */
  totalCount: number;
  /** Distinct users with at least one reward row in the window. */
  activeClaimants: number;
  /** Sum of wager-side ledger types in the window (GGR numerator side). */
  totalWager: number;
  /** Sum of payout-side ledger types in the window. */
  totalPayouts: number;
  /** GGR = wagers − payouts. House-POV: positive = house profit. */
  ggr: number;
  /**
   * Marketing cost as % of GGR. `null` when GGR is non-positive so the
   * UI can render "—" instead of an infinite / negative ratio.
   */
  marketingPctOfGgr: number | null;
  /**
   * Marketing cost as % of total wager. `null` when no wager. Different
   * lens from %-of-GGR — answers "for every dollar wagered, how many
   * cents did we spend on marketing".
   */
  marketingPctOfWager: number | null;
  /**
   * Period-over-period delta vs the prior equal window. `null` when the
   * period is "all" (lifetime has no prior frame). Each ratio is a
   * fraction (-1.0 to +∞), e.g. 0.25 = +25% vs prior.
   */
  priorWindow: {
    totalCost: number;
    totalCount: number;
    activeClaimants: number;
    /** (current − prior) / prior, `null` when prior was zero. */
    costDelta: number | null;
    countDelta: number | null;
    claimantDelta: number | null;
  } | null;
};

async function computeCrossCategorySummary(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RewardsCrossCategorySummary> {
  const db = await getDb();
  const days = daysForInsightsPeriod(period);
  const blacklistSubquery = blacklistNotInClause("id", blacklistIds);

  // Build the per-window WHERE-clause snippet. Splitting it out keeps
  // the prior-equal query exactly symmetric to the current one — same
  // status filter, same staff/blacklist exclusion, same ledger-type
  // sets — so the comparison is apples-to-apples by construction.
  const buildScopeClause = (
    dateClause: string,
    typesSql: string,
  ) => `
    WHERE lt.status = 'completed'
      AND lt.type IN ${typesSql}
      AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
      ${dateClause}
  `;

  const currentDateClause =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";

  // Single round-trip — rewards / wagers / payouts side by side via
  // FILTER on the same scan. The status + user-scope filter is
  // identical across the three buckets so the row count stays bounded
  // by the window.
  const currentRows = await db.$queryRawUnsafe<
    {
      reward_total: string;
      reward_count: string;
      reward_claimants: string;
      wager_total: string;
      payout_total: string;
    }[]
  >(`
    SELECT
      COALESCE(SUM(CASE WHEN lt.type IN ${REWARD_TYPES_SQL} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS reward_total,
      COUNT(*) FILTER (WHERE lt.type IN ${REWARD_TYPES_SQL})::text AS reward_count,
      COUNT(DISTINCT lt.user_id) FILTER (WHERE lt.type IN ${REWARD_TYPES_SQL})::text AS reward_claimants,
      COALESCE(SUM(CASE WHEN lt.type IN ${WAGER_TYPES_SQL} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS wager_total,
      COALESCE(SUM(CASE WHEN lt.type IN ${PAYOUT_TYPES_SQL} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS payout_total
    FROM ledger_transactions lt
    ${buildScopeClause(
      currentDateClause,
      `(${REWARD_TYPES_SQL.slice(1, -1)},${WAGER_TYPES_SQL.slice(1, -1)},${PAYOUT_TYPES_SQL.slice(1, -1)})`,
    )}
  `);

  const cur = currentRows[0];
  const ledgerCost = toNumber(cur?.reward_total);
  const ledgerCount = Number(cur?.reward_count ?? 0);
  const activeClaimants = Number(cur?.reward_claimants ?? 0);
  const totalWager = toNumber(cur?.wager_total);
  const totalPayouts = toNumber(cur?.payout_total);
  const ggr = totalWager - totalPayouts;

  // Fold in the daily / free pack giveaway cost. Daily packs
  // (`packs.pack_type='reward'`) are a ~$0-wager giveaway of real cards
  // that never books a reward LEDGER row, so the ledger-only sweep above
  // under-counts the true marketing cost. The giveaway cost is the value
  // of cards handed out (NOT net of the near-zero wager — that wager
  // already lives on the GGR side via pack_opening). Each open is its own
  // payout event, so `count` is additive. `activeClaimants` stays the
  // ledger-distinct figure: daily-pack claimers overlap the ledger set in
  // an unknown way, and naively summing the two distinct counts would
  // double-count — keeping it ledger-only avoids inflating it.
  const dailyPacks = await getDailyPacksTotalCost(period);
  const totalCost = ledgerCost + dailyPacks.cost;
  const totalCount = ledgerCount + dailyPacks.count;

  const marketingPctOfGgr =
    ggr > 0 ? (totalCost / ggr) * 100 : null;
  const marketingPctOfWager =
    totalWager > 0 ? (totalCost / totalWager) * 100 : null;

  // Prior window — only when the period is finite. Symmetric scope to
  // current so the deltas are apples-to-apples.
  let priorWindow: RewardsCrossCategorySummary["priorWindow"] = null;
  if (days !== null) {
    const priorDateClause = `AND lt.created_at >= NOW() - INTERVAL '${days * 2} days' AND lt.created_at < NOW() - INTERVAL '${days} days'`;
    const priorRows = await db.$queryRawUnsafe<
      {
        reward_total: string;
        reward_count: string;
        reward_claimants: string;
      }[]
    >(`
      SELECT
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS reward_total,
        COUNT(*)::text AS reward_count,
        COUNT(DISTINCT lt.user_id)::text AS reward_claimants
      FROM ledger_transactions lt
      ${buildScopeClause(priorDateClause, REWARD_TYPES_SQL)}
    `);
    const prev = priorRows[0];
    const prevCost = toNumber(prev?.reward_total);
    const prevCount = Number(prev?.reward_count ?? 0);
    const prevClaimants = Number(prev?.reward_claimants ?? 0);
    const delta = (now: number, prev: number): number | null =>
      prev > 0 ? (now - prev) / prev : null;
    // Deltas compare ledger-only current vs ledger-only prior so the
    // period-over-period frame stays apples-to-apples (the prior-window
    // sweep is ledger-only; daily packs aren't re-queried for an
    // arbitrary prior window). The headline totals above DO include daily
    // packs — only the delta basis is ledger-only.
    priorWindow = {
      totalCost: prevCost,
      totalCount: prevCount,
      activeClaimants: prevClaimants,
      costDelta: delta(ledgerCost, prevCost),
      countDelta: delta(ledgerCount, prevCount),
      claimantDelta: delta(activeClaimants, prevClaimants),
    };
  }

  return {
    totalCost,
    totalCount,
    activeClaimants,
    totalWager,
    totalPayouts,
    ggr,
    marketingPctOfGgr,
    marketingPctOfWager,
    priorWindow,
  };
}

/**
 * Cached entry-point. Cache key carries the period + the sorted
 * blacklist signature so admin edits to the excluded-users list bust
 * stale aggregates on the next tick.
 *
 * 60s revalidate for finite windows, 5m for lifetime — finite windows
 * change as new ledger rows land; the lifetime sweep barely moves
 * second-to-second and is heavier, so the longer TTL is cheaper.
 */
const cachedCrossCategorySummary = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCrossCategorySummary(period, blacklistIds),
  ["insights-rewards-cross-summary-v1"],
  {
    // unstable_cache reads the static config once; we pick the TTL per
    // call inside the wrapper below. This baseline (60s) covers every
    // window; the lifetime wrapper uses its own cached function.
    revalidate: 60,
    tags: ["rewards-analytics", "insights-rewards"],
  },
);

const cachedCrossCategorySummaryLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeCrossCategorySummary(period, blacklistIds),
  ["insights-rewards-cross-summary-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards"] },
);

export async function getRewardsCrossCategorySummary(
  period: InsightsRewardsPeriod,
): Promise<RewardsCrossCategorySummary> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedCrossCategorySummaryLifetime(period, sorted)
    : cachedCrossCategorySummary(period, sorted);
}
