import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { blacklistNotInClause } from "./_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  type DashboardPeriod,
  periodToCutoff,
} from "./dashboard-period";

// ─── Canonical metric layer — the SINGLE source of truth ─────────────
//
// `/ggr` owns its own breakdown but derives every NUMBER from
// `@/lib/metrics`: the headline GGR/NGR from `getWindowMetrics`, the
// gaming legs from `getGamingLegs`, the reward giveback from
// `getRewardCost`, and the neutral-conversion total from
// `sumLedgerTypes(NEUTRAL_TYPES)`. The type SETS are imported (never
// inlined), so the imminent voucher reclassification
// (`voucher_redeemed` → neutral, `battle_excess_to_voucher` → gaming)
// propagates here automatically. Formulas (GGR/NGR) are NOT
// reimplemented — they come straight out of `getWindowMetrics`.
import {
  NEUTRAL_TYPES,
  REWARD_PAYOUT_TYPES,
  WAGER_TYPES_SQL,
  GAMING_PAYOUT_TYPES_SQL,
  ledgerTypesToSqlList,
} from "@/lib/metrics";
import {
  getWindowMetrics,
  getGamingLegs,
  getRewardCost,
  upgraderMetrics,
  sumLedgerTypes,
  type MetricWindow,
} from "@/lib/metrics/queries";
// The CANONICAL "real customer" scope — staff + blacklist dropped,
// creators KEPT, creator-on-session rows excluded per-row via session
// windows. The page's own per-type / per-category / per-user queries adopt
// the SAME scope the headline (`getWindowMetrics`) uses so their figures
// reconcile with it (the old wholesale `role NOT IN (…,'creator')` drop
// diverged — it dropped a creator's off-session real-customer play that
// the headline counts). "One scope, fixed once." Import/call only.
import { getMetricsScope } from "@/lib/metrics/scope";
// The CANONICAL wager/payout-side borrow + reward-pack predicates — the
// EXACT fragments `getGamingLegs` ANDs in. Imported (never duplicated) so
// the page's per-category and per-user legs cannot drift from the headline:
// battle_sponsorship counted directly (no borrow gate) + reward/daily packs
// excluded on both sides. Client-safe module (no DB / server-only import).
import { WAGER_LEG_FILTER, PAYOUT_LEG_FILTER } from "@/lib/metrics/gaming-sql";

/**
 * ggr.ts — the `/ggr` page's OWN data layer.
 *
 * The long-form GGR breakdown page used to read a per-ledger-type
 * `getGgrBreakdown` out of `dashboard.ts`. That helper was migrated onto
 * the canonical inventory-delta GGR model (commit 3b30a7b) and now
 * returns only three collapsed synthetic legs — the rich per-type
 * breakdown the page was built around (neutral conversions + reward
 * giveback) vanished. This module rebuilds that breakdown directly on
 * `@/lib/metrics`, owning the page's shape so `dashboard.ts` stays a
 * settled file.
 *
 * The breakdown is organised into the THREE canonical groups the metric
 * partition defines (`ledger-sets.ts`):
 *
 *   1. Gaming payouts — the payout side of GGR. The dominant pack/battle
 *      win (`user_inventory.value_at_obtained` delta) + the `battle_refund`
 *      cash leg (`GAMING_PAYOUT_TYPES`) + upgrader payout. These REDUCE
 *      GGR (house cost on the games). Shown alongside the wager side so
 *      the GGR = wager − gamingPayout identity is visible.
 *   2. Neutral conversions — `NEUTRAL_TYPES` (card_sale / voucher_redeemed
 *      / exchanges). Inventory↔balance / voucher↔balance disposals of
 *      value the user ALREADY owns. NOT house cost, NOT losses — they are
 *      net-neutral to GGR and NGR and shown clearly labelled as such.
 *   3. Reward giveback — `REWARD_PAYOUT_TYPES` (deposit_bonus, rakeback,
 *      race prizes, rain, …). House-funded incentive spend that reduces
 *      NGR but NOT GGR.
 *
 * Upgrader is INCLUDED in the headline GGR/NGR (from `upgrader_games` via
 * the canonical `upgraderMetrics`), matching the game-economics figure on
 * `/insights/games`. While `UPGRADER_IN_LEDGER` is false, `getWindowMetrics`
 * reports the ledger-only gaming margin, so the upgrader leg is fetched
 * separately and folded in here.
 *
 * Read-only; server-only. Auth is enforced by the page / export route
 * that calls these (`requirePageAccess("/ggr")`).
 */

// ─── Window helper ───────────────────────────────────────────────────

/**
 * Convert a `/ggr` window chip to the canonical `MetricWindow` the
 * `@/lib/metrics` builders take. `/ggr` only exposes the rolling
 * 24h / 3d / 7d windows, none of which is lifetime, so this always
 * produces a real `since` cutoff. Kept as a single helper so the page,
 * the export, and the contributor query agree on the window.
 */
export function ggrWindowToMetricWindow(
  window: DashboardPeriod,
  now: Date = new Date(),
): MetricWindow {
  return window === "all"
    ? { since: null }
    : { since: periodToCutoff(window, now) };
}

// ─── Breakdown shapes ────────────────────────────────────────────────

/** A single ledger-type row inside the neutral / reward groups. */
export type GgrLedgerTypeRow = {
  /** Raw `ledger_transactions.type` — keys into `describeLedgerType`. */
  type: string;
  /** Σ |amount| over the window. Always non-negative. */
  total: number;
  /**
   * Optional display-label override. Used for the per-row carve-out where a
   * single ledger type is split across groups by a `metadata` slice and the
   * raw type name alone would be ambiguous — currently only the admin
   * house-granted voucher slice (`voucher_redeemed` +
   * `metadata->>'origin'='manual'`), which is lifted into the REWARD group
   * while the remaining `voucher_redeemed` stays NEUTRAL. When unset the
   * page derives the label from `describeLedgerType(type)`.
   */
  label?: string;
};

/** A single synthetic leg inside the gaming-payouts group. */
export type GgrGamingLeg = {
  /** Display label (e.g. "Pack & battle wins (inventory)"). */
  label: string;
  /** Σ for the window. Always non-negative. */
  total: number;
};

export type GgrPageData = {
  /**
   * Headline gaming-margin figures for the window — upgrader INCLUDED.
   * `ggr` / `ngr` are signed house-POV (positive = house up).
   */
  headline: {
    /** Σ wager (ledger WAGER_TYPES + upgrader bet), borrow-corrected. */
    wager: number;
    /** Σ gaming payout (inventory wins + battle_refund + upgrader payout). */
    gamingPayout: number;
    /** wager − gamingPayout (gaming-only, house POV). */
    ggr: number;
    /** GGR − reward giveback − net rain (house POV). */
    ngr: number;
    /** Empirical RTP 0..1, or null below MIN_SAMPLE. */
    rtp: number | null;
    /** Empirical house edge 0..1, or null below MIN_SAMPLE. */
    houseEdge: number | null;
    /** Settled gaming bet count (wager rows + upgrader plays). */
    bets: number;
  };

  /**
   * Group 1 — gaming payouts. The wager side (one combined figure) and
   * the payout legs that reduce GGR. `ggr` here equals `headline.ggr`.
   */
  gaming: {
    /** Combined pack + battle + upgrader wager. */
    wager: number;
    /** Payout legs (inventory wins, battle_refund, upgrader payout). */
    legs: GgrGamingLeg[];
    /** Σ of the payout legs = `headline.gamingPayout`. */
    payoutTotal: number;
    /** wager − payoutTotal = `headline.ggr`. */
    ggr: number;
  };

  /**
   * Per-category split of the SAME canonical gaming wager the headline
   * uses, so the three sum to `headline.wager` by construction
   * (packs + battles + upgrader = total gaming wager).
   *
   *  • `packs`    — Σ |pack_opening| (non-borrow), the pack_opening slice
   *                 of the ledger wager leg `getGamingLegs` sums.
   *  • `battles`  — Σ |battle_bet| + Σ |battle_sponsorship| (non-borrow),
   *                 the remaining slice of that SAME ledger wager leg.
   *                 Sponsorship IS customer wager; it is derived from the
   *                 identical leg/filter the headline uses (NOT a divergent
   *                 hand-rolled sum), so it picks up the borrow-filter
   *                 sponsorship fix automatically when that lands.
   *  • `upgrader` — upgrader `bet_amount` from the canonical
   *                 `upgraderMetrics` (the SAME `upg.wager` folded into the
   *                 headline). 0 when `upgrader_games` is absent.
   *
   * Each carries the play `count` (settled wager rows / upgrader plays).
   */
  categoryWager: {
    packs: { wager: number; count: number };
    battles: { wager: number; count: number };
    upgrader: { wager: number; count: number };
  };

  /**
   * Group 2 — neutral conversions (`NEUTRAL_TYPES`). NOT house cost; they
   * move value the user already owns. `total` is informational only and
   * does NOT enter GGR or NGR.
   *
   * The admin house-granted voucher slice (`voucher_redeemed` +
   * `metadata->>'origin'='manual'`) is carved OUT of this group and into
   * `reward` (canonically REWARD cost), so `total` and the
   * `voucher_redeemed` row exclude it — matching the canonical
   * neutral-vs-reward split.
   */
  neutral: {
    rows: GgrLedgerTypeRow[];
    total: number;
  };

  /**
   * Group 3 — reward giveback (`REWARD_PAYOUT_TYPES` + the manual-voucher
   * carve-out). House-funded incentive spend that reduces NGR (not GGR).
   *
   * `rain_win` is shown as its own row at its GROSS magnitude (what the
   * user received), but only the NET house slice
   * (`max(0, rain_win − rain_tip)`) reduces NGR — the canonical model.
   * `appliedToNgr` is the figure that actually reduced NGR
   * (rewardCostExclRain + net rain) so the card footer can reconcile.
   *
   * The admin house-granted voucher slice (`voucher_redeemed` +
   * `metadata->>'origin'='manual'`) appears here as its own row and is
   * already inside `costExclRain` (and thus `appliedToNgr`) — mirroring the
   * canonical `getRewardCost` manual carve-out.
   */
  reward: {
    rows: GgrLedgerTypeRow[];
    /** Σ of every reward row at gross magnitude (display total). */
    total: number;
    /** Reward cost EXCLUDING rain (the unambiguous $-for-$ giveback). */
    costExclRain: number;
    /** Gross Σ |rain_win| over the window. */
    rainWinTotal: number;
    /** Σ |rain_tip| netted against rain_win in the NGR model. */
    rainTipTotal: number;
    /** Net house slice of rain = max(0, rain_win − rain_tip). */
    rainHouseCost: number;
    /** costExclRain + rainHouseCost — the total that reduced NGR. */
    appliedToNgr: number;
  };

  /** True when the connected DB carries `upgrader_games` (prod). */
  upgraderAvailable: boolean;
};

// ─── Per-type detail query (neutral + reward groups) ─────────────────
//
// One GROUP BY over the union of NEUTRAL_TYPES ∪ REWARD_PAYOUT_TYPES,
// scoped through the same real-customer predicate the canonical metric
// layer uses. This gives the per-type CARD rows; the GROUP TOTALS and
// the headline come from the canonical functions (`sumLedgerTypes`,
// `getRewardCost`, `getWindowMetrics`), so the cards reconcile with the
// headline by construction (same sets, same scope).
//
// MANUAL-VOUCHER CARVE-OUT (mirrors `getRewardCost` in
// `@/lib/metrics/queries`): `voucher_redeemed` is NEUTRAL by default, but
// the admin house-granted slice (`metadata->>'origin'='manual'`) is the
// ONLY ledger touchpoint of a house-funded voucher, so the canonical NGR
// lifts that slice into REWARD cost. This query therefore splits
// `voucher_redeemed` into its manual slice (emitted as a REWARD row) and
// its remainder (kept as the NEUTRAL row), and returns the manual total so
// the caller can subtract it from the neutral group total — keeping
// `/ggr`'s neutral-vs-reward split byte-for-byte with canonical.
//
// SCOPE: the CANONICAL `getMetricsScope()` (staff + blacklist dropped,
// creators KEPT, creator-on-session rows excluded per-row) — the SAME
// population the headline / `sumLedgerTypes` / `getRewardCost` use, so the
// per-type card totals reconcile with the canonical group totals.

async function getNeutralAndRewardRows(
  window: MetricWindow,
): Promise<{
  neutral: GgrLedgerTypeRow[];
  reward: GgrLedgerTypeRow[];
  /**
   * Σ |amount| of the manual voucher slice (`voucher_redeemed` +
   * `metadata->>'origin'='manual'`) lifted from NEUTRAL into REWARD. The
   * caller subtracts this from the neutral group total so the neutral and
   * reward totals reconcile with canonical (which counts it as reward).
   */
  manualVoucherTotal: number;
}> {
  return withTiming("ggr.neutralRewardRows", async () => {
    const db = await getDb();
    const scope = await getMetricsScope();
    const since = window.since;
    const sinceFrag =
      since === null
        ? ""
        : `AND created_at >= '${since.toISOString()}'::timestamptz`;

    // Single GROUP BY over NEUTRAL_TYPES ∪ REWARD_PAYOUT_TYPES. The IN
    // list is rendered from the canonical type sets via
    // `ledgerTypesToSqlList` (hardcoded enum strings — injection is
    // structurally impossible), so it tracks the sets automatically. The
    // manual voucher slice is split out in the SAME pass via a
    // `metadata->>'origin'` GROUP BY key, so no second query is needed.
    const typeList = ledgerTypesToSqlList([
      ...NEUTRAL_TYPES,
      ...REWARD_PAYOUT_TYPES,
    ]);

    // `is_manual_voucher` is COALESCE-guarded so it is a strict boolean
    // (never NULL): a voucher_redeemed row with NULL/absent metadata
    // resolves to FALSE (non-manual → neutral), not a third NULL group.
    // This mirrors the canonical `getRewardCost`, where a non-'manual'
    // origin (incl. NULL) falls to the reward-leg ELSE 0.
    type Row = { type: string; is_manual_voucher: boolean; total: string };
    const rows = await db.$queryRawUnsafe<Row[]>(
      `WITH ${scope.sessionWindowsCte}
       SELECT type::text AS type,
              (type = 'voucher_redeemed'
                 AND COALESCE(metadata->>'origin', '') = 'manual') AS is_manual_voucher,
              COALESCE(SUM(ABS(amount::numeric)), 0)::text AS total
       FROM ledger_transactions
       WHERE status = 'completed'
         AND type IN ${typeList}
         AND user_id IN ${scope.userScopeSql}
         AND ${scope.notInCreatorSession("user_id", "created_at")}
         ${sinceFrag}
       GROUP BY type,
                (type = 'voucher_redeemed'
                   AND COALESCE(metadata->>'origin', '') = 'manual')`,
    );

    const neutralSet = new Set<string>(NEUTRAL_TYPES);
    const rewardSet = new Set<string>(REWARD_PAYOUT_TYPES);
    const neutral: GgrLedgerTypeRow[] = [];
    const reward: GgrLedgerTypeRow[] = [];
    let manualVoucherTotal = 0;

    for (const r of rows) {
      const total = toNumber(r.total);
      if (total <= 0) continue;
      // Manual voucher slice → REWARD cost (admin house-granted voucher),
      // labelled distinctly so it doesn't read as the neutral redemption.
      if (r.is_manual_voucher) {
        manualVoucherTotal += total;
        reward.push({
          type: "voucher_redeemed",
          total,
          label: "Admin voucher (manual grant)",
        });
        continue;
      }
      if (neutralSet.has(r.type)) neutral.push({ type: r.type, total });
      else if (rewardSet.has(r.type)) reward.push({ type: r.type, total });
    }
    neutral.sort((a, b) => b.total - a.total);
    reward.sort((a, b) => b.total - a.total);
    return { neutral, reward, manualVoucherTotal };
  });
}

// ─── Per-category gaming wager split (packs vs battles) ──────────────
//
// Splits the SAME ledger wager leg `getGamingLegs` sums (WAGER_TYPES,
// completed, real customers, non-borrow + reward-pack-excluded) into its
// pack_opening slice and its battle_bet + battle_sponsorship slice. The
// wager-side predicate is the CANONICAL `WAGER_LEG_FILTER` imported from
// `@/lib/metrics/gaming-sql` — the EXACT same fragment `getGamingLegs`
// ANDs in — so the two slices partition the identical row set and
// `packs + battles === legs.wager − legs.upgraderWager` (the ledger
// component of the headline wager) by construction. Upgrader is added in
// `getGgrPageData` from the SAME `legs.upgraderWager` the headline folds
// in, so packs + battles + upgrader === headline.wager.
//
// Using the shared predicate fixes two bugs the old hand-rolled filter
// had vs the canonical headline:
//   • battle_sponsorship was gated on `game_session_id IN (non-borrow
//     battle sessions)`, but sponsorship rows carry game_session_id=NULL
//     → silently dropped. WAGER_LEG_FILTER counts battle_sponsorship
//     DIRECTLY (all sponsored battles are borrow_percentage=0).
//   • reward/daily packs (packs.pack_type='reward', ≈$0) were NOT
//     excluded; WAGER_LEG_FILTER drops them (Fix 2).
//
// SCOPE: the CANONICAL `getMetricsScope()` (the SAME population
// `getGamingLegs` uses) so `packs + battles` reconciles with the headline
// ledger wager leg (`legs.wager − legs.upgraderWager`); + upgrader =
// `headline.wager`. The old wholesale-creator-drop scope diverged from the
// headline (it dropped creator off-session play the headline counts).

async function getCategoryLedgerWager(
  window: MetricWindow,
): Promise<{
  packs: { wager: number; count: number };
  battles: { wager: number; count: number };
}> {
  return withTiming("ggr.categoryWager", async () => {
    const db = await getDb();
    const scope = await getMetricsScope();
    const since = window.since;
    const sinceFrag =
      since === null
        ? ""
        : `AND created_at >= '${since.toISOString()}'::timestamptz`;

    type Row = {
      packs_wager: string;
      packs_count: string;
      battles_wager: string;
      battles_count: string;
    };
    // Unaliased `FROM ledger_transactions` (mirroring `getGamingLegs`) so
    // the canonical `WAGER_LEG_FILTER` columns (type / description /
    // game_session_id) resolve unqualified. The CASE then splits only the
    // WAGER_TYPES rows that pass that shared filter into packs vs battles,
    // so the two slices sum back to the headline's ledger wager leg.
    const rows = await db.$queryRawUnsafe<Row[]>(
      `WITH ${scope.sessionWindowsCte}
       SELECT
         COALESCE(SUM(CASE WHEN type = 'pack_opening'
                           THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS packs_wager,
         COALESCE(SUM(CASE WHEN type = 'pack_opening'
                           THEN 1 ELSE 0 END), 0)::text AS packs_count,
         COALESCE(SUM(CASE WHEN type IN ('battle_bet','battle_sponsorship')
                           THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battles_wager,
         COALESCE(SUM(CASE WHEN type IN ('battle_bet','battle_sponsorship')
                           THEN 1 ELSE 0 END), 0)::text AS battles_count
       FROM ledger_transactions
       WHERE status = 'completed'
         AND user_id IN ${scope.userScopeSql}
         AND ${scope.notInCreatorSession("user_id", "created_at")}
         AND type IN ${WAGER_TYPES_SQL}
         ${sinceFrag}
         AND ${WAGER_LEG_FILTER}`,
    );

    const r = rows[0];
    return {
      packs: { wager: toNumber(r?.packs_wager), count: toNumber(r?.packs_count) },
      battles: {
        wager: toNumber(r?.battles_wager),
        count: toNumber(r?.battles_count),
      },
    };
  });
}

// ─── Page data ───────────────────────────────────────────────────────

/**
 * Assemble the full `/ggr` page payload for a window. Composes the
 * canonical headline (`getWindowMetrics`), the upgrader leg
 * (`upgraderMetrics`), the gaming legs (`getGamingLegs`), the reward
 * giveback (`getRewardCost`), the neutral total
 * (`sumLedgerTypes(NEUTRAL_TYPES)`), and the per-type detail rows.
 *
 * Upgrader is folded into the headline wager / payout / GGR / NGR /
 * bets so the page reports the same game-economics margin as
 * `/insights/games`. NGR rises by the upgrader GGR contribution (upgrader
 * has no reward leg of its own).
 */
export async function getGgrPageData(
  window: MetricWindow,
): Promise<GgrPageData> {
  const [metrics, upg, legs, reward, neutralTotal, detail, categoryLedger] =
    await Promise.all([
      getWindowMetrics({ window }),
      upgraderMetrics(window),
      getGamingLegs(window),
      getRewardCost(window),
      sumLedgerTypes({ types: NEUTRAL_TYPES, window }),
      getNeutralAndRewardRows(window),
      getCategoryLedgerWager(window),
    ]);

  // Headline figures come STRAIGHT from `getWindowMetrics`, which already
  // folds upgrader in (via `getGamingLegs` reading `upgrader_games`). The
  // page must NOT re-add the upgrader leg — doing so double-counted it
  // (the headline already contains pack + battle + upgrader). `metrics.*`
  // is therefore used directly; the upgrader-only slices for the breakdown
  // come from `legs.upgrader*` (the SAME fold the headline used), never a
  // second standalone read.
  const wager = metrics.wager;
  const gamingPayout = metrics.gamingPayout;
  const ggr = metrics.ggr;
  const ngr = metrics.ngr;
  const bets = metrics.bets;

  // Upgrader-only slices, already INCLUDED in the headline via
  // `getGamingLegs`. Sourced from `legs` (not the standalone `upg` read)
  // so the breakdown row equals the slice the headline folded in.
  const upgraderWager = legs.upgraderWager;
  const upgraderPayout = legs.upgraderPayout;
  const upgraderBets = legs.upgraderBets;

  // Gaming payout legs — the inventory win delta (dominant), the
  // ledger gaming-payout cash leg, and (when present) the upgrader payout.
  // `legs.battleRefund` carries the ledger gaming-payout legs PLUS upgrader
  // payout, so the standalone upgrader payout is subtracted out into its
  // own row to keep the three legs summing to `gamingPayout` exactly
  // (inventory + battle-refund-only + upgrader = headline gamingPayout).
  const ledgerGamingPayout = legs.battleRefund - upgraderPayout;
  const gamingLegs: GgrGamingLeg[] = [
    { label: "Pack & battle wins (inventory)", total: legs.inventoryPayout },
    { label: "Battle refund (cash winner leg)", total: ledgerGamingPayout },
  ];
  if (upgraderPayout > 0) {
    gamingLegs.push({ label: "Upgrader payout", total: upgraderPayout });
  }

  return {
    headline: {
      wager,
      gamingPayout,
      ggr,
      ngr,
      // RTP / house-edge come straight from the canonical metrics — they
      // are computed there on the SAME upgrader-inclusive legs, so the
      // page reports the identical sample-guarded ratios.
      rtp: metrics.rtp,
      houseEdge: metrics.houseEdge,
      bets,
    },
    gaming: {
      wager,
      legs: gamingLegs,
      payoutTotal: gamingPayout,
      ggr,
    },
    // Per-category wager split. packs + battles = the ledger wager leg
    // (`legs.wager − legs.upgraderWager` = `metrics.wager` minus upgrader);
    // + upgrader (the SAME `legs.upgraderWager` folded into the headline)
    // = `headline.wager` by construction.
    categoryWager: {
      packs: categoryLedger.packs,
      battles: categoryLedger.battles,
      upgrader: { wager: upgraderWager, count: upgraderBets },
    },
    neutral: {
      rows: detail.neutral,
      // `sumLedgerTypes(NEUTRAL_TYPES)` counts ALL voucher_redeemed, but
      // the admin house-granted slice (`metadata->>'origin'='manual'`) is
      // canonically REWARD cost (it is in `getRewardCost.rewardCostExclRain`
      // and shown as a reward row). Subtract it so the neutral total
      // excludes what the reward side already counts — no double-count, and
      // neutral-vs-reward matches canonical.
      total: neutralTotal - detail.manualVoucherTotal,
    },
    reward: {
      rows: detail.reward,
      total: detail.reward.reduce((s, r) => s + r.total, 0),
      costExclRain: reward.rewardCostExclRain,
      rainWinTotal: reward.rainWinTotal,
      rainTipTotal: reward.rainTipTotal,
      rainHouseCost: metrics.rainHouseCost,
      appliedToNgr: reward.rewardCostExclRain + metrics.rainHouseCost,
    },
    upgraderAvailable: upg !== null,
  };
}

// ─── Top contributors ────────────────────────────────────────────────

export type GgrTopContributorRow = {
  userId: string;
  username: string | null;
  /** Per-user gaming wager (ledger WAGER_TYPES + upgrader, borrow-corrected). */
  wagerTotal: number;
  /** Per-user gaming payout (inventory wins + |battle_refund| + upgrader). */
  payoutTotal: number;
  /** wagerTotal − payoutTotal. Positive = user lost (house profited). */
  net: number;
};

/**
 * Per-user net contribution to GGR for the window — drives the top-10
 * contributors table. Uses the canonical inventory-delta model so each
 * user's `net` reconciles with the headline GGR: wager (ledger
 * WAGER_TYPES + upgrader) − (inventory pack/battle win delta +
 * |battle_refund| + upgrader payout), borrow-corrected on both sides.
 *
 * Upgrader is folded in (from `upgrader_games`) so contributors line up
 * with the upgrader-inclusive headline; the join degrades gracefully on
 * a pre-upgrader DB (the `to_regclass` guard skips the upgrader leg).
 *
 * NOT cached — the per-user ledger + inventory + upgrader join is heavier
 * than the window aggregate. Returns at most `limit` rows (default 10),
 * ordered by ABS(net) DESC.
 *
 * The borrow + reward-pack predicates are the CANONICAL shared fragments
 * (`WAGER_LEG_FILTER` / `PAYOUT_LEG_FILTER` from `@/lib/metrics/gaming-sql`)
 * — the EXACT ones `getGamingLegs` ANDs in — so the per-user legs cannot
 * drift from the headline: battle_sponsorship is counted DIRECTLY (no
 * borrow gate) and reward/daily packs are dropped on both sides.
 *
 * SCOPE: the pack/battle legs use the CANONICAL `getMetricsScope()` (staff
 * + blacklist dropped, creators KEPT, creator-on-session rows excluded
 * per-row), the SAME population the headline uses, so a user's `net`
 * matches their contribution to the headline GGR. The upgrader leg uses
 * the wholesale-creator-drop scope (`role NOT IN
 * ('admin','support','creator')` + blacklist) to match the canonical
 * `upgraderMetrics` reader the headline folds in — the SAME documented
 * minor asymmetry as `getGamingLegs` (creator off-session pack/battle play
 * counts; creator upgrader never does).
 */
export async function getGgrTopContributors(
  window: MetricWindow,
  limit = 10,
): Promise<GgrTopContributorRow[]> {
  return withTiming("ggr.topContributors", async () => {
    // Defensive clamp — the export passes a number; an out-of-range value
    // shouldn't blow up the query plan.
    const safeLimit = Math.max(1, Math.min(limit, 50));
    const db = await getDb();
    const scope = await getMetricsScope();
    // Blacklist for the upgrader leg's wholesale-drop user filter (the
    // pack/battle legs get blacklist + staff drop via `scope.userScopeSql`).
    const excluded = await getExcludedUserIds();
    const blacklist = blacklistNotInClause("u.id", excluded);
    const since = window.since;
    const sinceLedger =
      since === null
        ? ""
        : `AND lt.created_at >= '${since.toISOString()}'::timestamptz`;
    const sinceInv =
      since === null
        ? ""
        : `AND ui.obtained_at >= '${since.toISOString()}'::timestamptz`;

    // Probe upgrader_games — fold the per-user upgrader leg in only when
    // the table exists (to_regclass returns NULL, not an error, when it
    // is absent on a pre-upgrader DB).
    const probe = await db.$queryRaw<{ exists: string | null }[]>`
      SELECT to_regclass('public.upgrader_games')::text AS exists`;
    const hasUpgrader = probe[0]?.exists != null;
    const sinceUpg =
      since === null
        ? ""
        : `AND ug.created_at >= '${since.toISOString()}'::timestamptz`;

    // Upgrader leg uses the WHOLESALE-creator-drop scope (matching the
    // canonical `upgraderMetrics` the headline folds in), NOT `real_users`
    // (which keeps creators for the pack/battle legs). So creator upgrader
    // play is excluded here exactly as it is from the headline.
    const upgraderLegCte = hasUpgrader
      ? `, upg_leg AS (
           SELECT ug.user_id,
             COALESCE(SUM(ug.bet_amount::numeric), 0) AS upg_wager,
             COALESCE(SUM(ug.won_amount::numeric), 0) AS upg_payout
           FROM upgrader_games ug
           WHERE ug.user_id IN (
             SELECT u.id FROM "user" u
             WHERE u.role NOT IN ('admin', 'support', 'creator') ${blacklist}
           ) ${sinceUpg}
           GROUP BY ug.user_id
         )`
      : "";
    const upgWagerSelect = hasUpgrader
      ? "COALESCE(up.upg_wager, 0)"
      : "0";
    const upgPayoutSelect = hasUpgrader
      ? "COALESCE(up.upg_payout, 0)"
      : "0";
    const upgJoin = hasUpgrader
      ? "LEFT JOIN upg_leg up ON up.user_id = ru.id"
      : "";

    type QueryRow = {
      user_id: string;
      username: string | null;
      wager_total: string;
      payout_total: string;
      net: string;
    };
    const rows = await db.$queryRawUnsafe<QueryRow[]>(
      `WITH ${scope.sessionWindowsCte},
       real_users AS (
         SELECT u.id, u.username
         FROM "user" u
         WHERE u.id IN ${scope.userScopeSql}
       ),
       ledger_leg AS (
         SELECT
           lt.user_id,
           COALESCE(SUM(CASE WHEN lt.type IN ${WAGER_TYPES_SQL}
                             THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS wager_total,
           COALESCE(SUM(CASE WHEN lt.type IN ${GAMING_PAYOUT_TYPES_SQL}
                             THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS battle_refund_total
         FROM ledger_transactions lt
         JOIN real_users ru ON ru.id = lt.user_id
         WHERE lt.status = 'completed'
           ${sinceLedger}
           -- Creator-on-session rows excluded per-row (canonical scope),
           -- symmetric with the inventory leg below.
           AND ${scope.notInCreatorSession("lt.user_id", "lt.created_at")}
           -- CANONICAL wager-side predicate (WAGER_LEG_FILTER from
           -- gaming-sql.ts): battle_sponsorship counted DIRECTLY (no
           -- borrow gate — its game_session_id is NULL; the old gate
           -- dropped it), reward/daily packs excluded (Fix 2). The
           -- GAMING_PAYOUT_TYPES rows (battle_refund +
           -- battle_excess_to_voucher) pass via the filter's type-NOT-IN
           -- arm, so the battle_refund_total leg is unaffected.
           AND ${WAGER_LEG_FILTER}
         GROUP BY lt.user_id
       ),
       inv_leg AS (
         SELECT
           ui.user_id,
           COALESCE(SUM(ui.value_at_obtained::numeric), 0) AS inv_payout
         FROM user_inventory ui
         JOIN real_users ru ON ru.id = ui.user_id
         WHERE ui.source_type IN ('pack','battle')
           ${sinceInv}
           -- Creator-on-session rows excluded per-row, keyed on obtained_at
           -- (symmetric with the wager side's created_at predicate).
           AND ${scope.notInCreatorSession("ui.user_id", "ui.obtained_at")}
           -- CANONICAL payout-side predicate (PAYOUT_LEG_FILTER from
           -- gaming-sql.ts): non-borrow pack/battle won cards, then
           -- reward/daily-pack won cards dropped (Fix 2) so the giveaway
           -- is not counted as a per-user gaming payout.
           AND ${PAYOUT_LEG_FILTER}
         GROUP BY ui.user_id
       )${upgraderLegCte},
       per_user AS (
         SELECT
           ru.id AS user_id,
           ru.username,
           COALESCE(l.wager_total, 0) + ${upgWagerSelect} AS wager_total,
           COALESCE(i.inv_payout, 0) + COALESCE(l.battle_refund_total, 0) + ${upgPayoutSelect} AS payout_total
         FROM real_users ru
         LEFT JOIN ledger_leg l ON l.user_id = ru.id
         LEFT JOIN inv_leg i ON i.user_id = ru.id
         ${upgJoin}
         WHERE COALESCE(l.wager_total, 0) <> 0
            OR COALESCE(i.inv_payout, 0) <> 0
            OR COALESCE(l.battle_refund_total, 0) <> 0
            ${hasUpgrader ? "OR COALESCE(up.upg_wager, 0) <> 0 OR COALESCE(up.upg_payout, 0) <> 0" : ""}
       )
       SELECT
         pu.user_id::text AS user_id,
         pu.username,
         pu.wager_total::text AS wager_total,
         pu.payout_total::text AS payout_total,
         (pu.wager_total - pu.payout_total)::text AS net
       FROM per_user pu
       ORDER BY ABS(pu.wager_total - pu.payout_total) DESC
       LIMIT ${safeLimit}`,
    );

    return rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      wagerTotal: toNumber(r.wager_total),
      payoutTotal: toNumber(r.payout_total),
      net: toNumber(r.net),
    }));
  });
}
