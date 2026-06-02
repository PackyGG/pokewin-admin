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
  empiricalRtp,
  empiricalHouseEdge,
} from "@/lib/metrics";
import {
  getWindowMetrics,
  getGamingLegs,
  getRewardCost,
  upgraderMetrics,
  sumLedgerTypes,
  type MetricWindow,
} from "@/lib/metrics/queries";

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
   */
  neutral: {
    rows: GgrLedgerTypeRow[];
    total: number;
  };

  /**
   * Group 3 — reward giveback (`REWARD_PAYOUT_TYPES`). House-funded
   * incentive spend that reduces NGR (not GGR).
   *
   * `rain_win` is shown as its own row at its GROSS magnitude (what the
   * user received), but only the NET house slice
   * (`max(0, rain_win − rain_tip)`) reduces NGR — the canonical model.
   * `appliedToNgr` is the figure that actually reduced NGR
   * (rewardCostExclRain + net rain) so the card footer can reconcile.
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
// TODO: switch to central scope helper — `@/lib/metrics/queries` exposes
// no per-TYPE breakdown builder (it is window-aggregate only) and the
// shared `realCustomersScopeSql` lives under `insights-games/` which is
// being consolidated; the scope predicate is mirrored inline here
// (identical to `realCustomersScope` in `@/lib/metrics/queries`) until
// the consolidation exports a reusable per-type scope helper.

async function getNeutralAndRewardRows(
  window: MetricWindow,
): Promise<{
  neutral: GgrLedgerTypeRow[];
  reward: GgrLedgerTypeRow[];
}> {
  return withTiming("ggr.neutralRewardRows", async () => {
    const db = await getDb();
    const excluded = await getExcludedUserIds();
    const blacklist = blacklistNotInClause("u.id", excluded);
    const since = window.since;
    const sinceClause =
      since === null
        ? ""
        : `AND lt.created_at >= '${since.toISOString()}'::timestamptz`;

    // Single GROUP BY over NEUTRAL_TYPES ∪ REWARD_PAYOUT_TYPES. The IN
    // list is rendered from the canonical type sets via
    // `ledgerTypesToSqlList` (hardcoded enum strings — injection is
    // structurally impossible), so it tracks the sets automatically.
    const typeList = ledgerTypesToSqlList([
      ...NEUTRAL_TYPES,
      ...REWARD_PAYOUT_TYPES,
    ]);

    type Row = { type: string; total: string };
    const rows = await db.$queryRawUnsafe<Row[]>(
      `WITH real_users AS (
         SELECT u.id FROM "user" u
         WHERE u.role NOT IN ('admin', 'support', 'creator') ${blacklist}
       )
       SELECT lt.type::text AS type,
              COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total
       FROM ledger_transactions lt
       JOIN real_users ru ON ru.id = lt.user_id
       WHERE lt.status = 'completed'
         AND lt.type IN ${typeList}
         ${sinceClause}
       GROUP BY lt.type`,
    );

    const neutralSet = new Set<string>(NEUTRAL_TYPES);
    const rewardSet = new Set<string>(REWARD_PAYOUT_TYPES);
    const neutral: GgrLedgerTypeRow[] = [];
    const reward: GgrLedgerTypeRow[] = [];

    for (const r of rows) {
      const total = toNumber(r.total);
      if (total <= 0) continue;
      if (neutralSet.has(r.type)) neutral.push({ type: r.type, total });
      else if (rewardSet.has(r.type)) reward.push({ type: r.type, total });
    }
    neutral.sort((a, b) => b.total - a.total);
    reward.sort((a, b) => b.total - a.total);
    return { neutral, reward };
  });
}

// ─── Per-category gaming wager split (packs vs battles) ──────────────
//
// Splits the SAME ledger wager leg `getGamingLegs` sums (WAGER_TYPES,
// completed, real customers, borrow-corrected) into its pack_opening
// slice and its battle_bet + battle_sponsorship slice. Because the WHERE
// clause (scope + borrow filter) is byte-for-byte the same as
// `getGamingLegs`, the two slices partition the identical row set, so
// `packs + battles === legs.wager` (the ledger component of the headline
// wager) by construction. Upgrader is added in `getGgrPageData` from the
// SAME `upg.wager` the headline folds in, so packs + battles + upgrader
// === headline.wager.
//
// TODO: switch to central scope helper — same note as
// `getNeutralAndRewardRows` / `getGgrTopContributors`: `@/lib/metrics`
// exposes no per-CATEGORY wager builder, and the real-customer +
// borrow-exclusion predicate is mirrored inline (identical to
// `getGamingLegs` in `@/lib/metrics/queries`) until the consolidation
// exports a reusable per-category helper.

async function getCategoryLedgerWager(
  window: MetricWindow,
): Promise<{
  packs: { wager: number; count: number };
  battles: { wager: number; count: number };
}> {
  return withTiming("ggr.categoryWager", async () => {
    const db = await getDb();
    const excluded = await getExcludedUserIds();
    const blacklist = blacklistNotInClause("u.id", excluded);
    const since = window.since;
    const sinceClause =
      since === null
        ? ""
        : `AND lt.created_at >= '${since.toISOString()}'::timestamptz`;

    type Row = {
      packs_wager: string;
      packs_count: string;
      battles_wager: string;
      battles_count: string;
    };
    // The borrow filter is the SAME predicate as `getGamingLegs`'
    // ledger leg: pack_opening dropped when tagged "borrow" in its
    // description; battle_bet / battle_sponsorship dropped when their
    // battle has borrow_percentage > 0. The category CASE splits only
    // the WAGER_TYPES rows that pass that filter, so the two slices sum
    // back to the headline's ledger wager leg.
    const rows = await db.$queryRawUnsafe<Row[]>(
      `WITH real_users AS (
         SELECT u.id FROM "user" u
         WHERE u.role NOT IN ('admin', 'support', 'creator') ${blacklist}
       ),
       non_borrow_battle_sessions AS (
         SELECT bp.game_session_id FROM battle_participants bp
         JOIN battles b ON b.id = bp.battle_id
         WHERE COALESCE(b.borrow_percentage, 0) = 0
       )
       SELECT
         COALESCE(SUM(CASE WHEN lt.type = 'pack_opening'
                           THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS packs_wager,
         COALESCE(SUM(CASE WHEN lt.type = 'pack_opening'
                           THEN 1 ELSE 0 END), 0)::text AS packs_count,
         COALESCE(SUM(CASE WHEN lt.type IN ('battle_bet','battle_sponsorship')
                           THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS battles_wager,
         COALESCE(SUM(CASE WHEN lt.type IN ('battle_bet','battle_sponsorship')
                           THEN 1 ELSE 0 END), 0)::text AS battles_count
       FROM ledger_transactions lt
       JOIN real_users ru ON ru.id = lt.user_id
       WHERE lt.status = 'completed'
         AND lt.type IN ${WAGER_TYPES_SQL}
         ${sinceClause}
         AND (
           (lt.type = 'pack_opening' AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%'))
           OR (lt.type IN ('battle_bet','battle_sponsorship') AND lt.game_session_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))
         )`,
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

  // Upgrader contribution — `getWindowMetrics` excludes it while
  // `UPGRADER_IN_LEDGER` is false, so fold it in for the headline.
  const upgraderWager = upg?.wager ?? 0;
  const upgraderPayout = upg?.payout ?? 0;
  const upgraderGgr = upg?.ggr ?? 0;
  const upgraderBets = upg?.bets ?? 0;

  const wager = metrics.wager + upgraderWager;
  const gamingPayout = metrics.gamingPayout + upgraderPayout;
  const ggr = metrics.ggr + upgraderGgr;
  // NGR = GGR − rewards − net rain. Upgrader adds to GGR with no reward
  // leg, so it flows straight into NGR by the same delta.
  const ngr = metrics.ngr + upgraderGgr;
  const bets = metrics.bets + upgraderBets;

  // Gaming payout legs — the inventory win delta (dominant), the
  // battle_refund cash leg, and (when present) the upgrader payout.
  const gamingLegs: GgrGamingLeg[] = [
    { label: "Pack & battle wins (inventory)", total: legs.inventoryPayout },
    { label: "Battle refund (cash winner leg)", total: legs.battleRefund },
  ];
  if (upg && upgraderPayout > 0) {
    gamingLegs.push({ label: "Upgrader payout", total: upgraderPayout });
  }

  return {
    headline: {
      wager,
      gamingPayout,
      ggr,
      ngr,
      // Empirical RTP / house-edge on the UPGRADER-INCLUSIVE legs, via
      // the canonical sample-guarded formulas (`MIN_SAMPLE`). Not taken
      // from `metrics.rtp` because that excludes the upgrader leg.
      rtp: empiricalRtp({ gamingPayout, wager, bets }),
      houseEdge: empiricalHouseEdge({ wager, ggr, bets }),
      bets,
    },
    gaming: {
      wager,
      legs: gamingLegs,
      payoutTotal: gamingPayout,
      ggr,
    },
    // Per-category wager split. packs + battles = the ledger wager leg
    // (`legs.wager` = `metrics.wager`); + upgrader (the SAME `upg.wager`
    // folded into the headline) = `headline.wager` by construction.
    categoryWager: {
      packs: categoryLedger.packs,
      battles: categoryLedger.battles,
      upgrader: { wager: upgraderWager, count: upgraderBets },
    },
    neutral: {
      rows: detail.neutral,
      total: neutralTotal,
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
 * TODO: switch to central scope helper — the real-customer predicate
 * (`role NOT IN ('admin','support','creator')` + blacklist) and the
 * borrow-exclusion subqueries mirror the canonical `realCustomersScope` /
 * `getGamingLegs` in `@/lib/metrics/queries`. They are re-expressed here
 * only because that module exposes no per-USER builder (it is
 * window-aggregate only) and must not be edited from a page. The
 * canonical SQL list constants (`WAGER_TYPES_SQL` /
 * `GAMING_PAYOUT_TYPES_SQL`) are imported so the type sets cannot drift
 * from the headline. When the consolidation exports a reusable per-user
 * scope helper, swap this predicate for it.
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

    const upgraderLegCte = hasUpgrader
      ? `, upg_leg AS (
           SELECT ug.user_id,
             COALESCE(SUM(ug.bet_amount::numeric), 0) AS upg_wager,
             COALESCE(SUM(ug.won_amount::numeric), 0) AS upg_payout
           FROM upgrader_games ug
           JOIN real_users ru ON ru.id = ug.user_id
           WHERE TRUE ${sinceUpg}
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
      `WITH real_users AS (
         SELECT u.id, u.username
         FROM "user" u
         WHERE u.role NOT IN ('admin', 'support', 'creator') ${blacklist}
       ),
       non_borrow_pack_sessions AS (
         SELECT game_session_id FROM ledger_transactions
         WHERE type = 'pack_opening' AND status = 'completed'
           AND game_session_id IS NOT NULL
           AND (description IS NULL OR description NOT ILIKE '%borrow%')
       ),
       non_borrow_battle_sessions AS (
         SELECT bp.game_session_id FROM battle_participants bp
         JOIN battles b ON b.id = bp.battle_id
         WHERE COALESCE(b.borrow_percentage, 0) = 0
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
           AND (
             lt.type NOT IN ('pack_opening','battle_bet','battle_sponsorship')
             OR (lt.type = 'pack_opening' AND (lt.description IS NULL OR lt.description NOT ILIKE '%borrow%'))
             OR (lt.type IN ('battle_bet','battle_sponsorship') AND lt.game_session_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))
           )
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
           AND (
             (ui.source_type = 'pack' AND ui.source_id IN (SELECT game_session_id FROM non_borrow_pack_sessions))
             OR (ui.source_type = 'battle' AND ui.source_id IN (SELECT game_session_id FROM non_borrow_battle_sessions))
           )
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
