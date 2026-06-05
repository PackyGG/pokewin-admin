import "server-only";

import { unstable_cache } from "next/cache";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  getWindowMetrics,
  sumLedgerTypes,
  upgraderMetrics,
  type MetricWindow,
} from "@/lib/metrics/queries";
import { getMetricsScope } from "@/lib/metrics/scope";
import {
  WAGER_TYPES_SQL,
  GAMING_PAYOUT_TYPES_SQL,
} from "@/lib/metrics/ledger-sets";
import {
  WAGER_LEG_FILTER,
  PAYOUT_LEG_FILTER,
} from "@/lib/metrics/gaming-sql";
import { empiricalHouseEdge } from "@/lib/metrics/formulas";
import { getRakebackConfigs } from "@/lib/queries/rewards";
import { getAffiliateLevelConfigs } from "@/lib/queries/creators-analytics";
import { getAffiliateOverview } from "@/lib/queries/insights-rewards/affiliate/overview";
import { getDailyPacksTotalCost } from "@/lib/queries/insights-rewards/daily-packs";
import { getSignupOverview } from "@/lib/queries/insights-rewards/signup/overview";
import { getRaffleForecastBaseline } from "@/lib/queries/insights-rewards/raffle/overview";
import {
  daysForInsightsPeriodCapped,
  insightsRewardsPeriodLabel,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

import type {
  AffiliateTierLever,
  GameTypeBaseline,
  RakebackCadenceId,
  RakebackCadenceLever,
  SystemEdgeBaseline,
} from "./_model";

/**
 * _baseline.ts — assemble the REAL, serializable System Edge Plan baseline
 * (read-only, at request time).
 *
 * EVERYTHING here is real production data — NEVER invented (a prior agent
 * fabricated a "5% rakeback"; the rates below come straight from the live
 * `rakeback_config` / `affiliate_level_configs` tables and the canonical metric
 * layer):
 *
 *   • per-type wager / gaming payout / empirical edge / bets
 *       ← a per-type split of the canonical gaming legs (packs vs battles vs
 *         upgrader), built here with the EXACT canonical scope + borrow/reward
 *         filters (`getMetricsScope`, `WAGER_LEG_FILTER`, `PAYOUT_LEG_FILTER`)
 *         that `getGamingLegs` uses, so the three types sum to the canonical
 *         headline GGR by construction. Upgrader is sourced from
 *         `upgraderMetrics` (to_regclass-guarded → 0 / not-wired on a
 *         pre-upgrader DB).
 *   • headline wager / GGR / edge ← `getWindowMetrics` (canonical scope) — used
 *       to cross-check the per-type split + seed the blended edge.
 *   • per-lever realized reward cost (rakeback / affiliate / deposit bonus /
 *     race) ← `sumLedgerTypes` over the real ledger type(s) for each lever,
 *       under the SAME canonical scope, so the lever costs reconcile with NGR.
 *       `race` here is strictly the `race_prize` ledger type (on-site
 *       competitive RACES), NOT raffles.
 *   • raffle prize cost ← `getRaffleForecastBaseline().totalPrizeCost`. Raffles
 *       are a DISTINCT reward (ticket raffles); they pay out pack/card ITEMS via
 *       a `prizes` JSON (no ledger money leg), so the cost is RECONSTRUCTED by
 *       valuing each completed raffle's prizes at the live pack/card price. As a
 *       NON-ledger cost it is NOT inside the canonical NGR reward cost — it is
 *       added on top as its own lever (exactly like daily packs), so it never
 *       double-counts with the `race_prize` line.
 *   • daily-pack giveaway cost ← `getDailyPacksTotalCost` (Σ card value out).
 *   • signup balance-reward cost + avg grant ← `getSignupOverview`.
 *   • net rain cost ← `getWindowMetrics().rainHouseCost` (owner-confirmed
 *       `max(0, rain_win − rain_tip)`).
 *   • rakeback per-cadence rates ← `getRakebackConfigs()` → `rakeback_config`.
 *   • affiliate per-tier rates + thresholds ← `getAffiliateLevelConfigs()` →
 *       `affiliate_level_configs`.
 *   • blended affiliate rate + referred-wager anchor ← `getAffiliateOverview`.
 *
 * Active-timeframe-only (CLAUDE.md): the page mounts ONE baseline per `?period=`
 * inside a keyed `<Suspense>`, so only the selected window is fetched. Heavy
 * reads are wrapped in `unstable_cache` keyed on the period (60s / 300s).
 *
 * RESILIENCE (CRITICAL — the page must NEVER collapse to the insights error
 * boundary because ONE aggregate fails): EVERY query below is wrapped
 * INDIVIDUALLY in `safeQuery` with (a) a sensible LABELED fallback and (b) an
 * explicit `REWARD_QUERY_TIMEOUT_MS` budget. `safeQuery` catches a THROW (stale
 * column, JSON parse, NaN, missing table) AND — via the timeout — a merely SLOW
 * query (an unbounded scan on a larger prod dataset), so either failure mode
 * degrades ONLY that lever to its fallback (the lever renders as
 * data-unavailable / estimated) while every other lever and the whole page
 * still render. There is no un-guarded DB await on this path: the only awaits
 * are inside `getPackBattleLegs` (itself wrapped) and the two `Promise.all`s
 * whose every element is a `safeQuery`. Lifetime is bounded via
 * `daysForInsightsPeriodCapped` (no unbounded scans).
 */

/** The non-tunable reward legs NOT exposed as their own lever in the planner. */
const RAKEBACK_TYPES = ["rakeback_claim"] as const;
const AFFILIATE_TYPES = [
  "affiliate_claim",
  "affiliate_leaderboard_prize",
] as const;
const DEPOSIT_BONUS_TYPES = ["deposit_bonus"] as const;
const RACE_TYPES = ["race_prize"] as const;

/**
 * Backend-enforced deposit-bonus baseline reference (per the discovery — these
 * live in the GAME backend, not this admin). Surfaced as the lever's reference
 * point; the lever models the proportional cost effect of changing the cap /
 * window, it does NOT write them.
 */
const DEPOSIT_BONUS_BASELINE_CAP_USD = 100;
const DEPOSIT_BONUS_BASELINE_WINDOW_HOURS = 24;

/** Map an InsightsRewardsPeriod onto a canonical `MetricWindow` (lifetime bounded). */
function windowFor(period: InsightsRewardsPeriod): MetricWindow {
  // Bound lifetime so the canonical scans don't go full-history (CLAUDE.md
  // "Active-Timeframe-Only" — lifetime windows must be capped). Finite windows
  // resolve to their day count directly.
  const days = daysForInsightsPeriodCapped(period);
  return { since: new Date(Date.now() - days * 24 * 60 * 60 * 1000) };
}

function normalizeCadence(type: string): RakebackCadenceId | null {
  if (type === "daily" || type === "weekly" || type === "monthly") return type;
  return null;
}

/** Inline `AND created_at >= <since>` clause (since is always set by windowFor). */
function sinceClause(column: string, since: Date | null): string {
  if (since === null) return "";
  return `AND ${column} >= '${since.toISOString()}'::timestamptz`;
}

/**
 * Per-type pack/battle gaming legs — the per-type split of the canonical
 * `getGamingLegs` ledger + inventory reads.
 *
 * This mirrors `getGamingLegs` EXACTLY (same canonical session-window scope,
 * same `WAGER_LEG_FILTER` / `PAYOUT_LEG_FILTER` borrow + reward-pack
 * exclusions) but partitions the sums by game type:
 *   • WAGER:  pack_opening → packs · battle_bet + battle_sponsorship → battles
 *   • PAYOUT: user_inventory.source_type='pack' → packs · 'battle' → battles
 *
 * So packs.wager + battles.wager = the canonical ledger wager (excl. upgrader),
 * and packs.payout + battles.payout = the canonical inventory + battle-refund
 * payout — i.e. the two types reconcile with the headline by construction.
 * Upgrader is added separately by the caller from `upgraderMetrics`.
 */
type PackBattleLegs = {
  packsWager: number;
  battlesWager: number;
  packsBets: number;
  battlesBets: number;
  packsInvPayout: number;
  battlesInvPayout: number;
  /** Ledger cash gaming payout (battle_refund + battle_excess_to_voucher) — all battles. */
  battlesLedgerPayout: number;
};

async function getPackBattleLegs(window: MetricWindow): Promise<PackBattleLegs> {
  const db = await getDb();
  const scope = await getMetricsScope();
  const since = window.since;

  type WagerRow = {
    packs_wager: string;
    battles_wager: string;
    packs_bets: string;
    battles_bets: string;
  };
  type InvRow = { packs_inv: string; battles_inv: string };
  type LedgerPayoutRow = { battle_refund: string };

  const [wagerRows, invRows, ledgerPayoutRows] = await Promise.all([
    db.$queryRawUnsafe<WagerRow[]>(
      `WITH ${scope.sessionWindowsCte}
       SELECT
         COALESCE(SUM(CASE WHEN type::text = 'pack_opening' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS packs_wager,
         COALESCE(SUM(CASE WHEN type::text IN ('battle_bet','battle_sponsorship') THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battles_wager,
         COALESCE(SUM(CASE WHEN type::text = 'pack_opening' THEN 1 ELSE 0 END), 0)::text AS packs_bets,
         COALESCE(SUM(CASE WHEN type::text IN ('battle_bet','battle_sponsorship') THEN 1 ELSE 0 END), 0)::text AS battles_bets
       FROM ledger_transactions
       WHERE status = 'completed'
         AND type::text IN ${WAGER_TYPES_SQL}
         AND user_id IN ${scope.userScopeSql}
         AND ${scope.notInCreatorSession("user_id", "created_at")}
         ${sinceClause("created_at", since)}
         AND ${WAGER_LEG_FILTER}`,
    ),
    db.$queryRawUnsafe<InvRow[]>(
      `WITH ${scope.sessionWindowsCte}
       SELECT
         COALESCE(SUM(CASE WHEN source_type = 'pack' THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS packs_inv,
         COALESCE(SUM(CASE WHEN source_type = 'battle' THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS battles_inv
       FROM user_inventory
       WHERE source_type IN ('pack','battle')
         AND user_id IN ${scope.userScopeSql}
         AND ${scope.notInCreatorSession("user_id", "obtained_at")}
         ${sinceClause("obtained_at", since)}
         AND ${PAYOUT_LEG_FILTER}`,
    ),
    db.$queryRawUnsafe<LedgerPayoutRow[]>(
      `WITH ${scope.sessionWindowsCte}
       SELECT
         COALESCE(SUM(ABS(amount::numeric)), 0)::text AS battle_refund
       FROM ledger_transactions
       WHERE status = 'completed'
         AND type::text IN ${GAMING_PAYOUT_TYPES_SQL}
         AND user_id IN ${scope.userScopeSql}
         AND ${scope.notInCreatorSession("user_id", "created_at")}
         ${sinceClause("created_at", since)}`,
    ),
  ]);

  return {
    packsWager: toNumber(wagerRows[0]?.packs_wager),
    battlesWager: toNumber(wagerRows[0]?.battles_wager),
    packsBets: toNumber(wagerRows[0]?.packs_bets),
    battlesBets: toNumber(wagerRows[0]?.battles_bets),
    packsInvPayout: toNumber(invRows[0]?.packs_inv),
    battlesInvPayout: toNumber(invRows[0]?.battles_inv),
    battlesLedgerPayout: toNumber(ledgerPayoutRows[0]?.battle_refund),
  };
}

/**
 * Build the per-type gaming baseline (packs / battles / upgrader). The
 * battle_refund + battle_excess_to_voucher ledger payout legs are attributed to
 * BATTLES (they are battle-win settlement legs), so packs.payout is purely the
 * pack inventory delta. The three types' wager + payout sum to the canonical
 * `getGamingLegs` totals.
 */
function buildGameTypes(
  legs: PackBattleLegs,
  upg: { wager: number; payout: number; bets: number } | null,
): GameTypeBaseline[] {
  const packsPayout = legs.packsInvPayout;
  const battlesPayout = legs.battlesInvPayout + legs.battlesLedgerPayout;

  const packs: GameTypeBaseline = {
    type: "packs",
    wager: legs.packsWager,
    payout: packsPayout,
    ggr: legs.packsWager - packsPayout,
    edge: empiricalHouseEdge({
      wager: legs.packsWager,
      ggr: legs.packsWager - packsPayout,
      bets: legs.packsBets,
    }),
    bets: legs.packsBets,
    dataAvailable: legs.packsWager > 0,
  };
  const battles: GameTypeBaseline = {
    type: "battles",
    wager: legs.battlesWager,
    payout: battlesPayout,
    ggr: legs.battlesWager - battlesPayout,
    edge: empiricalHouseEdge({
      wager: legs.battlesWager,
      ggr: legs.battlesWager - battlesPayout,
      bets: legs.battlesBets,
    }),
    bets: legs.battlesBets,
    dataAvailable: legs.battlesWager > 0,
  };
  const upgrader: GameTypeBaseline = {
    type: "upgrader",
    wager: upg?.wager ?? 0,
    payout: upg?.payout ?? 0,
    ggr: (upg?.wager ?? 0) - (upg?.payout ?? 0),
    edge:
      upg != null
        ? empiricalHouseEdge({
            wager: upg.wager,
            ggr: upg.wager - upg.payout,
            bets: upg.bets,
          })
        : null,
    bets: upg?.bets ?? 0,
    // Upgrader figures only come from `upgrader_games`; null = no table on this
    // DB (pre-upgrader snapshot) → surface the lever but label it not-wired.
    dataAvailable: upg != null,
  };

  return [packs, battles, upgrader];
}

/**
 * Fetch + assemble the real baseline for a window. Cached per-period.
 *
 * The config reads (rakeback / affiliate ladders) are period-agnostic (the same
 * regardless of window) but are fetched here so the whole baseline is one cache
 * entry per period — they're cheap `findMany`s.
 */
async function buildBaseline(
  period: InsightsRewardsPeriod,
): Promise<SystemEdgeBaseline> {
  const window = windowFor(period);
  const periodDays = Math.max(1, daysForInsightsPeriodCapped(period));

  const [
    metricsRes,
    legsRes,
    upgRes,
    rakebackCostRes,
    affiliateCostRes,
    depositBonusCostRes,
    raceCostRes,
    raffleRes,
    dailyPacksRes,
    signupRes,
    rakebackCfgRes,
    affiliateCfgRes,
    affiliateOvRes,
  ] = await Promise.all([
    safeQuery(
      () => getWindowMetrics({ window }),
      null,
      "system-edge-plan.metrics",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getPackBattleLegs(window),
      null,
      "system-edge-plan.pack-battle-legs",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => upgraderMetrics(window),
      null,
      "system-edge-plan.upgrader",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => sumLedgerTypes({ types: RAKEBACK_TYPES, window }),
      0,
      "system-edge-plan.rakeback-cost",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => sumLedgerTypes({ types: AFFILIATE_TYPES, window }),
      0,
      "system-edge-plan.affiliate-cost",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => sumLedgerTypes({ types: DEPOSIT_BONUS_TYPES, window }),
      0,
      "system-edge-plan.deposit-bonus-cost",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => sumLedgerTypes({ types: RACE_TYPES, window }),
      0,
      "system-edge-plan.race-cost",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getRaffleForecastBaseline(period),
      null,
      "system-edge-plan.raffle",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getDailyPacksTotalCost(period),
      null,
      "system-edge-plan.daily-packs",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getSignupOverview(period),
      null,
      "system-edge-plan.signup",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getRakebackConfigs(),
      [],
      "system-edge-plan.rakeback-config",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getAffiliateLevelConfigs(),
      [],
      "system-edge-plan.affiliate-config",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getAffiliateOverview(period),
      null,
      "system-edge-plan.affiliate-overview",
      REWARD_QUERY_TIMEOUT_MS,
    ),
  ]);

  const metrics = metricsRes.data;

  // Per-type gaming legs (real). When the legs read failed, fall back to a
  // single blended "packs" row carrying the canonical headline so the page
  // still renders a real projection rather than zeros.
  const legs = legsRes.data;
  const upg = upgRes.data ?? null;
  let gameTypes: GameTypeBaseline[];
  if (legs != null) {
    gameTypes = buildGameTypes(legs, upg);
  } else {
    // Degraded: no per-type split available — represent the headline as a
    // single combined row so the model still has real anchors.
    const wager = metrics?.wager ?? 0;
    const payout = metrics?.gamingPayout ?? 0;
    gameTypes = [
      {
        type: "packs",
        wager,
        payout,
        ggr: wager - payout,
        edge: metrics?.houseEdge ?? null,
        bets: metrics?.bets ?? 0,
        dataAvailable: wager > 0,
      },
      {
        type: "battles",
        wager: 0,
        payout: 0,
        ggr: 0,
        edge: null,
        bets: 0,
        dataAvailable: false,
      },
      {
        type: "upgrader",
        wager: 0,
        payout: 0,
        ggr: 0,
        edge: null,
        bets: 0,
        dataAvailable: upg != null,
      },
    ];
  }

  const wager = gameTypes.reduce((s, g) => s + g.wager, 0);
  const gamingPayout = gameTypes.reduce((s, g) => s + g.payout, 0);
  const ggr = wager - gamingPayout;
  const bets = gameTypes.reduce((s, g) => s + g.bets, 0);
  const houseEdge =
    metrics?.houseEdge ?? (wager > 0 ? ggr / wager : null);

  const rakebackCost = rakebackCostRes.data ?? 0;
  const affiliateCost = affiliateCostRes.data ?? 0;
  const depositBonusCost = depositBonusCostRes.data ?? 0;
  const raceCost = raceCostRes.data ?? 0;
  // Real reconstructed raffle prize cost (NON-ledger item giveaway). Distinct
  // from races; added on top of the canonical reward cost like daily packs.
  const raffleCost = raffleRes.data?.totalPrizeCost ?? 0;
  const dailyPacksCost = dailyPacksRes.data?.cost ?? 0;
  const signupPacksCost = signupRes.data?.totalCost ?? 0;
  const signupClaimants = signupRes.data?.claimants ?? 0;
  const signupAvgGrant =
    signupRes.data != null && signupRes.data.claimants > 0
      ? signupRes.data.avgPerClaim
      : null;
  const rainCost = metrics?.rainHouseCost ?? 0;

  // Other reward cost = the canonical total reward cost (GGR − NGR) minus every
  // lever we itemize, so the planner's reward sum reconciles with NGR. The
  // remainder is gift cards / promo / waitlist / manual vouchers + counted
  // adjustments — held fixed (no lever), surfaced as an informational line.
  //
  // NOTE: the canonical NGR's reward cost includes the daily-pack giveaway via
  // the inventory leg? No — daily packs are EXCLUDED from gaming (Fix 2) and
  // their cost is NOT in the ledger (no ledger row), so the canonical NGR does
  // NOT carry the daily-pack cost. Likewise signup balance_reward_claim IS a
  // ledger reward type, so it IS in the canonical reward cost. To avoid
  // double-counting, `otherRewardCost` subtracts only the LEDGER-resident
  // levers (rakeback / affiliate / deposit bonus / RACE [race_prize] / signup /
  // rain) from the canonical reward cost. Daily packs AND raffles are NON-ledger
  // item giveaways (no ledger row → never in the canonical reward cost), so they
  // are added on top as separate lines and are NOT subtracted here — no
  // double-count with the race_prize line.
  const canonicalRewardCost = metrics != null ? metrics.ggr - metrics.ngr : 0;
  const ledgerLeverCost =
    rakebackCost +
    affiliateCost +
    depositBonusCost +
    raceCost +
    signupPacksCost +
    rainCost;
  const otherRewardCost = Math.max(0, canonicalRewardCost - ledgerLeverCost);

  // Real rakeback cadences (daily / weekly / monthly) from rakeback_config.
  const rakebackCadences: RakebackCadenceLever[] = (rakebackCfgRes.data ?? [])
    .map((c): RakebackCadenceLever | null => {
      const cadence = normalizeCadence(c.type);
      if (cadence == null) return null;
      return {
        cadence,
        label: c.displayName || cadenceLabel(cadence),
        currentRate: Math.max(0, c.percentage),
        enabled: c.enabled,
      };
    })
    .filter((c): c is RakebackCadenceLever => c != null)
    // Stable order: daily → weekly → monthly.
    .sort((a, b) => cadenceOrder(a.cadence) - cadenceOrder(b.cadence));

  // Real affiliate tiers from affiliate_level_configs.
  const affiliateTiers: AffiliateTierLever[] = (affiliateCfgRes.data ?? [])
    .map((c) => ({
      level: c.level,
      label: c.label || `Level ${c.level}`,
      currentRate: Math.max(0, c.commission_rate),
      threshold: Math.max(0, c.threshold),
    }))
    .sort((a, b) => a.level - b.level);

  // Real blended affiliate rate = total commission ÷ referred wager (when both
  // known). Informational only — the per-tier rates drive the projection.
  const ov = affiliateOvRes.data;
  const affiliateBlendedRate =
    ov != null && ov.downstreamWager > 0
      ? ov.totalCommissionPaid / ov.downstreamWager
      : null;

  return {
    periodLabel: insightsRewardsPeriodLabel(period),
    periodDays,

    gameTypes,
    wager,
    gamingPayout,
    ggr,
    houseEdge,
    bets,

    rakebackCost,
    affiliateCost,
    depositBonusCost,
    raceCost,
    raffleCost,
    dailyPacksCost,
    signupPacksCost,
    rainCost,
    otherRewardCost,

    rakebackCadences,
    affiliateTiers,
    affiliateBlendedRate,

    signupAvgGrant,
    signupClaimants,

    depositBonusCapUsd: DEPOSIT_BONUS_BASELINE_CAP_USD,
    depositBonusWindowHours: DEPOSIT_BONUS_BASELINE_WINDOW_HOURS,
  };
}

/** Cadence display order: daily → weekly → monthly. */
function cadenceOrder(c: RakebackCadenceId): number {
  return c === "daily" ? 0 : c === "weekly" ? 1 : 2;
}

function cadenceLabel(c: RakebackCadenceId): string {
  return c === "daily" ? "Daily" : c === "weekly" ? "Weekly" : "Monthly";
}

/**
 * A fully-zeroed, serializable baseline. The last-resort fallback if the whole
 * `buildBaseline` (or the cache machinery) ever throws for a reason NOT caught
 * by the per-query `safeQuery` wrappers (e.g. an unexpected post-processing
 * error or an `unstable_cache` infra error). Returning this — rather than
 * letting the throw bubble — keeps the page from collapsing into the insights
 * error boundary: `wager <= 0` makes the content layer render its clean
 * "no gameplay to anchor on" empty state instead. Belt-and-braces on top of the
 * per-query guards.
 */
function emptyBaseline(period: InsightsRewardsPeriod): SystemEdgeBaseline {
  const zeroType = (type: GameTypeBaseline["type"]): GameTypeBaseline => ({
    type,
    wager: 0,
    payout: 0,
    ggr: 0,
    edge: null,
    bets: 0,
    dataAvailable: false,
  });
  return {
    periodLabel: insightsRewardsPeriodLabel(period),
    periodDays: Math.max(1, daysForInsightsPeriodCapped(period)),
    gameTypes: [zeroType("packs"), zeroType("battles"), zeroType("upgrader")],
    wager: 0,
    gamingPayout: 0,
    ggr: 0,
    houseEdge: null,
    bets: 0,
    rakebackCost: 0,
    affiliateCost: 0,
    depositBonusCost: 0,
    raceCost: 0,
    raffleCost: 0,
    dailyPacksCost: 0,
    signupPacksCost: 0,
    rainCost: 0,
    otherRewardCost: 0,
    rakebackCadences: [],
    affiliateTiers: [],
    affiliateBlendedRate: null,
    signupAvgGrant: null,
    signupClaimants: 0,
    depositBonusCapUsd: DEPOSIT_BONUS_BASELINE_CAP_USD,
    depositBonusWindowHours: DEPOSIT_BONUS_BASELINE_WINDOW_HOURS,
  };
}

/**
 * Public entry — the cached baseline for a period. `unstable_cache` keyed on the
 * period with a period-aware TTL (60s short windows / 300s lifetime), mirroring
 * the insights-rewards cache discipline.
 *
 * Wrapped in `safeQuery` as the OUTERMOST guard: every individual aggregate
 * inside `buildBaseline` is already `safeQuery`-wrapped (so one failing query
 * only degrades its own lever), and this final wrapper catches any residual
 * throw from the assembly or the cache layer itself — so the page can NEVER
 * collapse to the insights error boundary from this read. On total failure it
 * degrades to a zeroed `emptyBaseline`, which the content layer renders as the
 * clean "no gameplay to anchor on" empty state.
 */
export async function getSystemEdgeBaseline(
  period: InsightsRewardsPeriod,
): Promise<SystemEdgeBaseline> {
  const cached = unstable_cache(
    () => buildBaseline(period),
    ["system-edge-plan-baseline-v3", period],
    { revalidate: cacheTtlForInsightsPeriod(period) },
  );
  const { data } = await safeQuery(
    () => cached(),
    emptyBaseline(period),
    "system-edge-plan.baseline",
    REWARD_QUERY_TIMEOUT_MS,
  );
  return data;
}
