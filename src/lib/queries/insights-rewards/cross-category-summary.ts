import { blacklistNotInSql, daysAgoFilter, queryRows, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import type { SQL } from "drizzle-orm";
import { unstable_cache } from "next/cache";
import { getDrizzleDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";
import {
  REWARD_PAYOUT_TYPES,
  ledgerTypesToSqlList,
  resolveRainHouseCost,
} from "@/lib/metrics";
import { countedAdjustmentSqlPredicate } from "@/lib/balance-adjustment-categories";
import {
  daysForInsightsPeriod,
  daysForInsightsPeriodCapped,
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
 * Reward ledger types come from the CANONICAL `REWARD_PAYOUT_TYPES`
 * partition in `@/lib/metrics` — the single source of truth for what
 * counts as a house-funded reward cost. This deliberately:
 *   • NETS rain to its house slice `max(0, Σ|rain_win| − Σ|rain_tip|)`
 *     (owner-confirmed model) instead of the gross `rain_win` magnitude —
 *     rain is system-automatic and mixed-funded; the user/founder tips
 *     that fed the pool were never the house's money, so gross rain_win
 *     over-states the cost. See `formulas.ts` `resolveRainHouseCost`.
 *   • EXCLUDES `creator_tip` — it is a verified user→user pass-through
 *     (RESIDUAL), not a house reward cost.
 *   • EXCLUDES `voucher_redeemed` (non-manual) — NEUTRAL (a voucher the
 *     user already holds becoming balance), so it is not in the canonical
 *     reward set and never counted as a cost here.
 * Vouchers are otherwise deliberately excluded — they live in a separate
 * view per the existing convention. Wager + payout sides for GGR follow
 * the dashboard breakdown:
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
 * Staff + creators + blacklist excluded (the canonical real-customer
 * scope — `role NOT IN ('admin','support','creator')`). The previous
 * `role NOT IN ('admin','support')` shape leaked creator reward rows into
 * the customer total, diverging from /rewards/analytics + the canonical
 * `getRewardCost`. Period-aware. Read-only sweep over ledger_transactions,
 * indexed via the existing user_id + type indexes.
 *
 * Reward COST mirrors `src/lib/metrics/queries.ts` `getRewardCost` exactly:
 * REWARD_PAYOUT_TYPES (excl rain_win) + manual-voucher carve-out
 * (`voucher_redeemed` origin manual) + counted-adjustment carve-out
 * (`countedAdjustmentSqlPredicate()`) + NET rain. The carve-outs were
 * previously omitted here, undercounting the cost; they are added so the
 * headline reconciles with the per-category breakdown on the same page.
 */

// Canonical reward set (incl. rain_win) — used for the payout COUNT +
// distinct-claimant figures, where a rain win is a genuine reward payout
// event received by a user (the netting below is a COST-only adjustment).
// `creator_tip` / `voucher_redeemed` are NOT in the canonical set, so they
// never inflate the count.
const REWARD_TYPES_SQL = ledgerTypesToSqlList(REWARD_PAYOUT_TYPES);

// Canonical reward set EXCLUDING rain_win — the unambiguously house-funded
// ($-for-$) reward cost. Rain is added back as its NET house slice
// (`max(0, rain_win − rain_tip)`) so it is not double-counted gross.
const REWARD_EXCL_RAIN_TYPES_SQL = ledgerTypesToSqlList(
  REWARD_PAYOUT_TYPES.filter((t) => t !== "rain_win"),
);

// Per-row carve-out predicate: an `admin_balance_adjustment` CREDIT whose
// category is COUNTED (bonus / giveaway / reload / lossback / deposit-fix /
// bugs / deposit_bonus) is a house-funded promo cost. Mirrors getRewardCost.
const COUNTED_ADJ_PREDICATE = countedAdjustmentSqlPredicate({
  typeColumn: "lt.type",
  metadataColumn: "lt.metadata",
  amountColumn: "lt.amount",
});

// The reward-cost SUM expression (excl rain) including the two per-row
// carve-outs (manual vouchers + counted adjustments). Used by both the
// current and prior-window scans so they stay symmetric.
const REWARD_EXCL_RAIN_SUM = `COALESCE(SUM(CASE
  WHEN lt.type::text IN ${REWARD_EXCL_RAIN_TYPES_SQL} THEN ABS(lt.amount::numeric)
  WHEN lt.type::text = 'voucher_redeemed' AND lt.metadata->>'origin' = 'manual' THEN ABS(lt.amount::numeric)
  WHEN ${COUNTED_ADJ_PREDICATE} THEN ABS(lt.amount::numeric)
  ELSE 0 END), 0)::text`;

// The extra source types the carve-outs scan (beyond REWARD_TYPES). Added
// to every scan's type filter so the carve-out rows are visible.
const CARVE_OUT_TYPES_SQL = `'voucher_redeemed','admin_balance_adjustment'`;

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
  const db = await getDrizzleDb();
  const days = daysForInsightsPeriod(period);
  const blacklistSubquery = blacklistNotInSql("id", blacklistIds);

  // Build the per-window WHERE-clause snippet. Splitting it out keeps
  // the prior-equal query exactly symmetric to the current one — same
  // status filter, same staff/blacklist exclusion, same ledger-type
  // sets — so the comparison is apples-to-apples by construction.
  const buildScopeClause = (
    dateClause: SQL,
    typesSql: SQL,
  ): SQL => sql`
    WHERE lt.status = 'completed'
      AND lt.type::text IN ${typesSql}
      AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support', 'creator') ${blacklistSubquery})
      ${dateClause}
  `;

  // Lifetime (`all`) is CAPPED to INSIGHTS_LIFETIME_LOOKBACK_DAYS (365d)
  // via daysForInsightsPeriodCapped so the headline reward-cost / GGR scan
  // never runs unbounded over the full ledger (CLAUDE.md "Performance &
  // Daten-Laden" — Lifetime-Fenster bounden). Finite windows are
  // unchanged. The prior-window comparison below only runs for finite
  // windows, so it is never unbounded.
  const currentDateClause = daysAgoFilter(
    "lt.created_at",
    daysForInsightsPeriodCapped(period),
  );

  // Single round-trip — rewards / wagers / payouts side by side via
  // FILTER on the same scan. The status + user-scope filter is
  // identical across the buckets so the row count stays bounded by the
  // window.
  //
  // Reward COST is split into the house-funded base (canonical reward
  // types EXCLUDING rain_win) plus the rain legs (rain_win / rain_tip)
  // summed separately so the rain house slice can be NETTED below
  // (`max(0, rain_win − rain_tip)`) rather than counted gross. The
  // count + distinct-claimant figures use the full canonical reward set
  // (rain wins are real reward payout events to users).
  //
  // `rain_tip` is the rain POOL FUNDING leg (user/founder contributions);
  // it is summed ONLY to net the rain cost and is included in the scan's
  // type filter for that reason — it is never added to the reward total.
  const currentRows = await queryRows<
    {
      reward_excl_rain: string;
      rain_win: string;
      rain_tip: string;
      reward_count: string;
      reward_claimants: string;
      wager_total: string;
      payout_total: string;
    }[]
  >(db, sql`
    SELECT
      ${sql.raw(REWARD_EXCL_RAIN_SUM)} AS reward_excl_rain,
      COALESCE(SUM(CASE WHEN lt.type::text = 'rain_win' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS rain_win,
      COALESCE(SUM(CASE WHEN lt.type::text = 'rain_tip' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS rain_tip,
      COUNT(*) FILTER (WHERE lt.type::text IN ${sql.raw(REWARD_TYPES_SQL)})::text AS reward_count,
      COUNT(DISTINCT lt.user_id) FILTER (WHERE lt.type::text IN ${sql.raw(REWARD_TYPES_SQL)})::text AS reward_claimants,
      COALESCE(SUM(CASE WHEN lt.type::text IN ${sql.raw(WAGER_TYPES_SQL)} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS wager_total,
      COALESCE(SUM(CASE WHEN lt.type::text IN ${sql.raw(PAYOUT_TYPES_SQL)} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS payout_total
    FROM ledger_transactions lt
    ${buildScopeClause(
      currentDateClause,
      // Scan reward types + rain_tip (net rain) + the carve-out source
      // types (manual voucher / counted adjustment) + wager/payout types.
      sql.raw(`(${REWARD_TYPES_SQL.slice(1, -1)},'rain_tip',${CARVE_OUT_TYPES_SQL},${WAGER_TYPES_SQL.slice(1, -1)},${PAYOUT_TYPES_SQL.slice(1, -1)})`),
    )}
  `);

  const cur = currentRows[0];
  // Net rain house cost (owner-confirmed): the system-funded base only,
  // user/founder tips netted out. Reused canonical helper — not a
  // hand-rolled formula.
  const rainHouseCost = resolveRainHouseCost({
    kind: "net",
    rainWinTotal: toNumber(cur?.rain_win),
    rainTipTotal: toNumber(cur?.rain_tip),
  });
  const ledgerCost = toNumber(cur?.reward_excl_rain) + rainHouseCost;
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
  // current so the deltas are apples-to-apples: the SAME canonical
  // reward set, the SAME net-rain treatment (`max(0, rain_win −
  // rain_tip)`), the SAME canonical-set count/claimant basis.
  let priorWindow: RewardsCrossCategorySummary["priorWindow"] = null;
  if (days !== null) {
    const priorDateClause = sql`
      AND lt.created_at >= NOW() - (${days * 2} * INTERVAL '1 day')
      AND lt.created_at < NOW() - (${days} * INTERVAL '1 day')
    `;
    const priorRows = await queryRows<
      {
        reward_excl_rain: string;
        rain_win: string;
        rain_tip: string;
        reward_count: string;
        reward_claimants: string;
      }[]
    >(db, sql`
      SELECT
        ${sql.raw(REWARD_EXCL_RAIN_SUM)} AS reward_excl_rain,
        COALESCE(SUM(CASE WHEN lt.type::text = 'rain_win' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS rain_win,
        COALESCE(SUM(CASE WHEN lt.type::text = 'rain_tip' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS rain_tip,
        COUNT(*) FILTER (WHERE lt.type::text IN ${sql.raw(REWARD_TYPES_SQL)})::text AS reward_count,
        COUNT(DISTINCT lt.user_id) FILTER (WHERE lt.type::text IN ${sql.raw(REWARD_TYPES_SQL)})::text AS reward_claimants
      FROM ledger_transactions lt
      ${buildScopeClause(
        priorDateClause,
        sql.raw(`(${REWARD_TYPES_SQL.slice(1, -1)},'rain_tip',${CARVE_OUT_TYPES_SQL})`),
      )}
    `);
    const prev = priorRows[0];
    const prevRainCost = resolveRainHouseCost({
      kind: "net",
      rainWinTotal: toNumber(prev?.rain_win),
      rainTipTotal: toNumber(prev?.rain_tip),
    });
    const prevCost = toNumber(prev?.reward_excl_rain) + prevRainCost;
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
  // -v2: canonical reward-cost alignment (real-customer scope dropping
  // creators + manual-voucher/counted-adjustment carve-outs) so the
  // headline reconciles with the per-category breakdown.
  ["insights-rewards-cross-summary-v2"],
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
  ["insights-rewards-cross-summary-lifetime-v2"],
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
