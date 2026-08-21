import "server-only";

import { getReadDrizzleDb } from "@/lib/db";
import { queryRows } from "@/lib/drizzle-query";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getWeightedCreatorGameplayByDay, getWeightedCreatorGameplayForWindow } from "@/lib/creator-pnl-settlement";
import {
  WAGER_TYPES_SQL,
  GAMING_PAYOUT_TYPES_SQL,
  REWARD_PAYOUT_TYPES_SQL,
  ledgerTypesToSqlList,
  type LedgerTransactionType,
} from "./ledger-sets";
import {
  countedAdjustmentSqlPredicate,
  officialStreamAdjustmentSqlPredicate,
  statsExcludedAdjustmentSqlPredicate,
} from "@/lib/balance-adjustment-categories";
import {
  ggr as ggrFormula,
  ngr as ngrFormula,
  gamingPayoutTotal,
  resolveRainHouseCost,
  empiricalRtp,
  empiricalHouseEdge,
  type RainHouseCost,
  type EmpiricalRatio,
} from "./formulas";
import { getMetricsScope } from "./scope";
import {
  WAGER_LEG_FILTER,
  PAYOUT_LEG_FILTER,
} from "./gaming-sql";

/**
 * queries.ts — the CANONICAL, WIRED DB-read builders for the metric layer.
 *
 * These are LIVE: `getWindowMetrics` / `getGamingLegs` / `getRewardCost` /
 * `getDailyGamingMetrics` / `upgraderMetrics` / `sumLedgerTypes` are the
 * canonical GGR/NGR/wager/payout source imported by the dashboard, `/ggr`,
 * the analytics surfaces, insights-analytics and insights-games. They read
 * the Main DB (game data) and return primitives. They are the DB-read
 * companions to the pure `formulas.ts` helpers: each one bakes in the
 * canonical scope (real customers, borrow-net-inclusive, blacklist-dropped)
 * so a consuming page never re-derives a type list or a scope predicate.
 *
 * The wager/payout shape is:
 *   • wager  ← ledger `pack_opening` / `battle_bet` / `battle_sponsorship`
 *   • payout ← `user_inventory.value_at_obtained`,
 *              `source_type IN ('pack','battle')`, by `obtained_at`
 *              + the ledger GAMING_PAYOUT cash legs (`battle_refund` +
 *              `battle_excess_to_voucher`)
 * with borrow plays counted at their net cash on BOTH sides (owner
 * decision, 2026-06-13 — see gaming-sql.ts). `battle_bet`'s `amount` is
 * already net of borrow, and the won-card / voucher legs are likewise net,
 * so both sides stay symmetric with the unconditional GAMING_PAYOUT legs.
 * Reward/daily packs are the only gaming exclusion.
 *
 * SNAPSHOT CAVEAT: the worktree snapshot is pre-upgrader (no
 * `upgrader_games` table, enum lacks `upgrader_*`). The upgrader builder
 * here therefore cannot be executed in this worktree; it is built from
 * the schema + the verified `dashboard-upgrader.ts` and gated behind a
 * runtime `to_regclass` table-existence check so it degrades to null
 * rather than throwing `42P01` on a migration-lagged DB.
 */

// ─── Window helper ───────────────────────────────────────────────────

/**
 * A metric window. `since: null` means lifetime (no lower bound). Kept as
 * an explicit Date (not a period string) so this layer stays decoupled
 * from any page's period parsing — callers convert their period to a
 * `since` and pass it in.
 */
export type MetricWindow = {
  since: Date | null;
};

// The canonical real-customer scope now lives in `./scope`
// (`getMetricsScope`): staff + creators + blacklist dropped WHOLESALE —
// `role NOT IN ('admin','support','creator')` (owner decision,
// 2026-06-03: creator play, on- OR off-session, is content, not customer
// revenue). The session-window predicate the scope also exposes is a
// permanently inert no-op kept only for the CTE-injection contract (see
// scope.ts). It is EXPORTED so the dashboard / analytics hand-rolled
// scopes can be swept onto it ("one scope, fixed once").

/** Inline `AND created_at >= <since>` clause, or empty for lifetime. */
function sinceClause(column: string, since: Date | null): string {
  if (since === null) return "";
  // Bind defensively as an ISO literal cast to timestamptz — `since` is a
  // server-constructed Date, never user input, but we still avoid string
  // concatenation of raw user data by formatting to ISO.
  return `AND ${column} >= '${since.toISOString()}'::timestamptz`;
}

// ─── Reward-pack exclusion fragments (borrow-net-inclusive) ──────────
//
// The composed wager/payout predicates
// (`WAGER_LEG_FILTER` / `PAYOUT_LEG_FILTER`) live
// in the client-safe `./gaming-sql` module so the pure `__checks__` can
// assert their shape without the DB. On the borrow-net-INCLUSIVE basis
// (owner decision, 2026-06-13 — see gaming-sql.ts):
//   • Borrow plays are COUNTED at their net cash on BOTH the wager and the
//     payout side — no borrow gate. `battle_bet`'s `amount` is already net
//     of borrow, and the won-card / `battle_excess_to_voucher` legs are
//     likewise net, so both sides stay symmetric with the unconditional
//     GAMING_PAYOUT legs (the old borrow-DROP basis dropped the wager but
//     kept those payout legs → impossible RTP).
//   • `battle_sponsorship` is counted as customer WAGER directly (its
//     `game_session_id` is NULL, all sponsored battles are
//     borrow_percentage=0).
//   • Reward/daily packs (`packs.pack_type='reward'`) are the ONLY gaming
//     exclusion — dropped from BOTH the wager and the won-card inventory
//     legs (a giveaway tracked as a reward cost in `/insights/rewards`,
//     not gaming). The reward-pack join mirrors
//     insights-rewards/daily-packs.ts.

// ─── Gaming legs (wager, inventory payout, ledger gaming payout) ─────

export type GamingLegs = {
  /**
   * Σ wager for the window, real customers (borrow plays counted at net
   * cash) — pack/battle ledger WAGER_TYPES PLUS upgrader
   * (`Σ upgrader_games.bet_amount`).
   *
   * Upgrader is INCLUDED here by default. It is NOT in the ledger
   * (`UPGRADER_IN_LEDGER` stays false) but it IS real gameplay, so the
   * canonical GGR must contain it — sourced from `upgrader_games` via
   * `upgraderMetrics` (to_regclass-guarded; contributes 0 on a
   * pre-upgrader DB). The pack/battle-only slice is `wager −
   * upgraderWager` (see `upgraderWager` below).
   */
  wager: number;
  /**
   * Σ `user_inventory.value_at_obtained` for source pack/battle, obtained
   * in window (borrow-won cards kept at net value) — the dominant
   * pack/battle payout. (Upgrader
   * payout is NOT here — it is in `battleRefund` alongside the ledger
   * gaming-payout legs; see below.)
   */
  inventoryPayout: number;
  /**
   * The non-inventory gaming payout for the window: the LEDGER cash
   * gaming-payout legs over GAMING_PAYOUT_TYPES — `battle_refund` (the
   * battle winner's cash leg) AND `battle_excess_to_voucher` (the voucher
   * remainder of a battle win the inventory card under-counts — booked at
   * settlement, completes the win; its later `voucher_redeemed` redemption
   * is NEUTRAL, so no double-count) — PLUS upgrader payout
   * (`Σ upgrader_games.won_amount`).
   *
   * Field name kept as `battleRefund` for call-site stability; it now
   * carries the ledger legs + upgrader payout. So `inventoryPayout +
   * battleRefund` = the full gaming payout (pack/battle + upgrader), which
   * keeps `getGgrBreakdown` (dashboard) reconciling with the headline
   * `getWindowMetrics.ggr` by construction. The upgrader-only slice is
   * `upgraderPayout` (see below); the ledger-only slice is `battleRefund −
   * upgraderPayout`.
   */
  battleRefund: number;
  /** COUNT of settled bets (pack/battle ledger wager rows + upgrader bets). */
  bets: number;
  /**
   * Upgrader wager only (`Σ upgrader_games.bet_amount`), already INCLUDED
   * in `wager`. Exposed so a breakdown can show an upgrader row without a
   * second read — do NOT add it to `wager` again. 0 on a pre-upgrader DB.
   */
  upgraderWager: number;
  /**
   * Upgrader payout only (`Σ upgrader_games.won_amount`), already INCLUDED
   * in `battleRefund`. Do NOT add it again. 0 on a pre-upgrader DB.
   */
  upgraderPayout: number;
  /** Upgrader bet count only, already INCLUDED in `bets`. */
  upgraderBets: number;
  /** Pack wager only, already included in `wager`. */
  packWager: number;
  /** Pack-opening wager event count, already included in `bets`. */
  packBets: number;
  /** Battle wager only, already included in `wager`. */
  battleWager: number;
  /** Battle wager/sponsorship event count, already included in `bets`. */
  battleBets: number;
  /** Keno wager only, already included in `wager`. */
  kenoWager: number;
  /** Keno bet count, already included in `bets`. */
  kenoBets: number;
  /** Keno payout only, already included in `battleRefund`. */
  kenoPayout: number;
  /**
   * Double Down wager only (Σ `battle_double_down_offers.won_amount_usd`
   * over RESOLVED rounds in window), already INCLUDED in `wager`. Do NOT
   * add it again. 0 on a pre-DD DB (`to_regclass` guard). DD is optional
   * gameplay on a battle win: the "wager" is the previously-won battle
   * amount the user chooses to re-stake. On a LOSS the whole stake is
   * forfeited (house recapture); on a WIN a payout voucher is minted
   * (`ddPayout`). Sourced from `battle_double_down_offers` — NOT the ledger
   * (DD money moves via the paired voucher, not a dedicated ledger type).
   */
  ddWager: number;
  /**
   * Double Down payout only (Σ paired voucher `value` for offers with
   * `result='win'` and `won_voucher_id IS NOT NULL`, voucher origin =
   * `battle_double_down_payout`). NOT included in `battleRefund` — passed
   * to `gamingPayoutTotal` as the separate `ddPayout` input so both surface
   * as first-class legs and the breakdown can show them independently.
   * 0 on a pre-DD DB.
   */
  ddPayout: number;
  /**
   * Double Down bet count only (COUNT of RESOLVED offers in window), already
   * INCLUDED in `bets`. 0 on a pre-DD DB.
   */
  ddBets: number;
  /** Canonical wager from customers without a creator-code referrer. */
  organicWager: number;
};

/**
 * Read the canonical gaming legs for a window. Three parallel reads:
 *   • ledger wager (WAGER_TYPES, borrow-net-inclusive) + bet count + the
 *     ledger gaming-payout sum (`battle_refund` + `battle_excess_to_voucher`
 *     over GAMING_PAYOUT_TYPES),
 *   • inventory payout (the dominant pack/battle win delta),
 *   • upgrader (`upgrader_games` via `upgraderMetrics`).
 *
 * Upgrader is FOLDED IN BY DEFAULT — its wager joins `wager`, its payout
 * joins `battleRefund`, its bets join `bets` — so the canonical GGR
 * (`getWindowMetrics`) and the dashboard GGR breakdown (which both read
 * these legs) cover packs, battles, Keno, Upgrader, and Double Down. Upgrader is sourced from
 * `upgrader_games` (NOT the ledger; `UPGRADER_IN_LEDGER` stays false) and
 * is `to_regclass`-guarded, contributing 0 on a pre-upgrader DB. The
 * upgrader-only slices are also returned separately (`upgraderWager` /
 * `upgraderPayout` / `upgraderBets`) for transparent breakdowns.
 */
export async function getGamingLegs(window: MetricWindow): Promise<GamingLegs> {
  return withTiming("metrics.gamingLegs", async () => {
    const db = await getReadDrizzleDb();
    // Canonical scope: staff + creators + blacklist dropped wholesale
    // (owner decision 2026-06-03). The session-window predicate below is
    // a permanently inert no-op kept for the CTE contract. See scope.ts.
    const scope = await getMetricsScope();
    const since = window.since;
    const metricsEnd = new Date().toISOString();

    type LedgerRow = {
      wager: string;
      organic_wager: string;
      battle_refund: string;
      bets: string;
      pack_wager: string;
      pack_bets: string;
      battle_wager: string;
      battle_bets: string;
      keno_wager: string;
      keno_bets: string;
      keno_payout: string;
    };
    type InvRow = { inv_payout: string };

    const [ledger, inv, upg, dd, pnlCreator] = await Promise.all([
      queryRows<LedgerRow[]>(db,
        `WITH ${scope.sessionWindowsCte}
         SELECT
           COALESCE(SUM(CASE WHEN type::text IN ${WAGER_TYPES_SQL} THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS wager,
           COALESCE(SUM(CASE
             WHEN type::text IN ${WAGER_TYPES_SQL}
              AND user_id IN (
                SELECT organic_user.id
                FROM "user" organic_user
                WHERE organic_user.id IN ${scope.userScopeSql}
                  AND NOT EXISTS (
                    SELECT 1 FROM "user" ref
                    WHERE ref.id = organic_user.referred_by
                      AND ref.role = 'creator'
                  )
              )
             THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS organic_wager,
           COALESCE(SUM(CASE WHEN type::text IN ${GAMING_PAYOUT_TYPES_SQL} THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_refund,
           COALESCE(SUM(CASE WHEN type::text IN ${WAGER_TYPES_SQL} THEN 1 ELSE 0 END), 0)::text AS bets,
           COALESCE(SUM(CASE WHEN type::text = 'pack_opening' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager,
           COALESCE(SUM(CASE WHEN type::text = 'pack_opening' THEN 1 ELSE 0 END), 0)::text AS pack_bets,
           COALESCE(SUM(CASE WHEN type::text IN ('battle_bet','battle_sponsorship') THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager,
           COALESCE(SUM(CASE WHEN type::text IN ('battle_bet','battle_sponsorship') THEN 1 ELSE 0 END), 0)::text AS battle_bets,
           COALESCE(SUM(CASE WHEN type::text = 'keno_bet' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS keno_wager,
           COALESCE(SUM(CASE WHEN type::text = 'keno_bet' THEN 1 ELSE 0 END), 0)::text AS keno_bets,
           COALESCE(SUM(CASE WHEN type::text = 'keno_payout' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS keno_payout
         FROM ledger_transactions
         WHERE status = 'completed'
           AND user_id IN ${scope.userScopeSql}
           AND ${scope.notInCreatorSession("user_id", "created_at")}
           ${sinceClause("created_at", since)}
           -- Wager-side predicate from the shared client-safe fragment so
           -- the pure __checks__ assert its exact shape. Borrow-net-
           -- INCLUSIVE: battle_bet is counted unconditionally (its amount
           -- is already net of borrow) and battle_sponsorship directly;
           -- reward/daily packs (pack_type='reward', ≈$0) are the only
           -- gaming exclusion. The GAMING_PAYOUT legs (battle_refund +
           -- battle_excess_to_voucher) are summed unconditionally within
           -- their type filter above — symmetric with this wager leg.
           AND ${WAGER_LEG_FILTER}`,
      ),
      queryRows<InvRow[]>(db,
        `WITH ${scope.sessionWindowsCte}
         SELECT
           COALESCE(SUM(value_at_obtained::numeric), 0)::text AS inv_payout
         FROM user_inventory
         WHERE source_type IN ('pack','battle')
           AND user_id IN ${scope.userScopeSql}
           -- Payout-side creator-on-session exclusion keyed on obtained_at,
           -- symmetric with the wager side's created_at predicate.
           AND ${scope.notInCreatorSession("user_id", "obtained_at")}
           ${sinceClause("obtained_at", since)}
           -- Payout-side predicate (borrow-net-inclusive): all pack/battle
           -- won cards are kept (their value_at_obtained is the net card
           -- value), then reward/daily-pack won cards are dropped (keyed on
           -- source_id = originating game_session_id) so the giveaway is
           -- not counted as a gaming payout. Shared predicate → asserted by
           -- __checks__.
           AND ${PAYOUT_LEG_FILTER}`,
      ),
      // Upgrader from upgrader_games (real gameplay, not in the ledger).
      // `null` on a pre-upgrader DB (to_regclass guard) → contributes 0.
      // upgraderMetrics inlines the same wholesale-creator-drop scope
      // (`role NOT IN ('admin','support','creator')` + blacklist) that
      // `getMetricsScope` applies to the ledger/inventory legs above, so
      // all legs are on the same population.
      upgraderMetrics(window),
      // Double Down from battle_double_down_offers (real gameplay, NOT in
      // the ledger — DD money moves via the paired payout voucher). Uses
      // the same wholesale-creator-drop scope as `upgraderMetrics` (a
      // superset of the session-window scope: creators are already dropped
      // wholesale by `getMetricsScope`'s CUSTOMER_EXCLUDED_ROLES, so a
      // per-row session-window exclusion is redundant for the tiny DD
      // table). `null` on a pre-DD DB → contributes 0.
      doubleDownLegs(window),
      getWeightedCreatorGameplayForWindow({ startIso: since?.toISOString(), endIso: metricsEnd }),
    ]);

    const ledgerWager = toNumber(ledger[0]?.wager);
    const ledgerOrganicWager = toNumber(ledger[0]?.organic_wager);
    const ledgerGamingPayout = toNumber(ledger[0]?.battle_refund);
    const ledgerBets = toNumber(ledger[0]?.bets);
    const packWager = toNumber(ledger[0]?.pack_wager);
    const packBets = toNumber(ledger[0]?.pack_bets);
    const battleWager = toNumber(ledger[0]?.battle_wager);
    const battleBets = toNumber(ledger[0]?.battle_bets);
    const kenoWager = toNumber(ledger[0]?.keno_wager);
    const kenoBets = toNumber(ledger[0]?.keno_bets);
    const kenoPayout = toNumber(ledger[0]?.keno_payout);
    const inventoryPayout = toNumber(inv[0]?.inv_payout);

    const upgraderWager = upg?.wager ?? 0;
    const upgraderOrganicWager = upg?.organicWager ?? 0;
    const upgraderPayout = upg?.payout ?? 0;
    const upgraderBets = upg?.bets ?? 0;

    const ddWager = dd?.wager ?? 0;
    const ddOrganicWager = dd?.organicWager ?? 0;
    const ddPayout = dd?.payout ?? 0;
    const ddBets = dd?.bets ?? 0;

    return {
      // Upgrader + Double Down folded into the headline legs by default.
      // DD wager joins `wager` and DD bets join `bets`; DD payout is passed
      // separately as `ddPayout` (not into `battleRefund`) so
      // `gamingPayoutTotal` sums it alongside the other legs — keeps the
      // breakdown transparent (a caller can subtract `ddPayout` to see the
      // pre-DD number). Losing DD rounds forfeit the stake: no `ddPayout`
      // row on a loss → the whole DD wager stays as GGR contribution.
      wager: ledgerWager + upgraderWager + ddWager + pnlCreator.weightedWagerUsd,
      battleRefund: ledgerGamingPayout + upgraderPayout + pnlCreator.weightedPayoutUsd,
      bets: ledgerBets + upgraderBets + ddBets + pnlCreator.weightedBetCount,
      inventoryPayout,
      // Upgrader-only slices (already included above; do not re-add).
      upgraderWager,
      upgraderPayout,
      upgraderBets,
      packWager,
      packBets,
      battleWager,
      battleBets,
      kenoWager,
      kenoBets,
      kenoPayout,
      // Double Down-only slices (already included above; do not re-add).
      ddWager,
      ddPayout,
      ddBets,
      organicWager:
        ledgerOrganicWager + upgraderOrganicWager + ddOrganicWager,
    };
  });
}

// ─── Double Down leg (reads battle_double_down_offers — GGR DD source) ─

/** Double Down leg totals for the metrics-layer fold. */
type DoubleDownLegs = {
  /** Σ `won_amount_usd` over RESOLVED offers in window (the stake). */
  wager: number;
  /** Σ paired voucher `value` for offers with `result='win'`. */
  payout: number;
  /** COUNT of RESOLVED offers in window. */
  bets: number;
  organicWager: number;
};

/**
 * Double Down gaming legs for the metrics-layer GGR fold — sourced from
 * `battle_double_down_offers` LEFT JOIN `vouchers` on `won_voucher_id`
 * (voucher origin `battle_double_down_payout`), matching the canonical
 * `@/lib/queries/double-down` reader that powers the /insights/double-down
 * surfaces and the dashboard DD panel:
 *
 *   • WAGER = Σ `won_amount_usd` FILTER (WHERE `result IS NOT NULL`) — the
 *     stake, summed over RESOLVED rounds. `won_amount_usd` is the battle
 *     winnings the user re-staked; on a LOSS the whole stake is forfeited
 *     (house recapture — no payout row); on a WIN the paired voucher's
 *     `value` is credited (payout, below).
 *   • PAYOUT = Σ `vouchers.value` FILTER (WHERE `result='win'`) — the REAL
 *     credited amount (reconciles exactly to the `voucher_redeemed` ledger
 *     amount, verified read-only on prod in `@/lib/queries/double-down`).
 *     NO multiplier, NO `metadata.payout_amount_usd` fallback (see the
 *     canonical DD reader's docstring for the prior 0.9× bug).
 *   • BETS = COUNT of RESOLVED rounds in window.
 *
 * Windowed on `resolved_at` (the settlement time — mirrors how
 * `battle_refund` / `battle_excess_to_voucher` bucket by settlement, and
 * how the DD KPI-strip stats are windowed). A pending accepted round has
 * `resolved_at IS NULL` and therefore contributes nothing until settled —
 * so a still-open round's stake doesn't inflate GGR.
 *
 * Scope: wholesale-creator-drop `role NOT IN ('admin','support','creator')`
 * + blacklist — same shape as `upgraderMetrics` and the canonical DD
 * reader's `customerScopeSql`. This is a superset of the session-window
 * scope used by the ledger/inventory legs (creators are already dropped
 * wholesale by `CUSTOMER_EXCLUDED_ROLES` in `scope.ts`), so a per-row
 * session-window exclusion here would be a redundant no-op. The tiny DD
 * table has no per-session `game_session_id` join anyway — DD is offered
 * AFTER a battle win, so gating on the parent battle's session-scope would
 * be a different (and stricter) predicate than the metrics layer uses
 * elsewhere.
 *
 * Returns `null` when the connected DB has no `battle_double_down_offers`
 * table (pre-DD snapshot) — `to_regclass` guard, same degradation as
 * `upgraderMetrics` — so the caller contributes 0 rather than throwing
 * `42P01`.
 */
async function doubleDownLegs(
  window: MetricWindow,
): Promise<DoubleDownLegs | null> {
  return withTiming("metrics.doubleDown", async () => {
    const db = await getReadDrizzleDb();

    // Probe: skip entirely if the table is absent (pre-DD DB).
    const probe = await queryRows<{ exists: string | null }[]>(
      db,
      "SELECT to_regclass('public.battle_double_down_offers')::text AS exists",
    );
    if (probe[0]?.exists == null) return null;

    const excluded = await getExcludedUserIds();
    const blacklist = blacklistNotInClause("id", excluded);
    const since = window.since;

    type Row = {
      wager: string;
      payout: string;
      bets: string;
      organic_wager: string;
    };
    const rows = await queryRows<Row[]>(db,
      `WITH real_users AS (
         SELECT id,
                EXISTS (
                  SELECT 1 FROM "user" ref
                  WHERE ref.id = u.referred_by AND ref.role = 'creator'
                ) AS under_creator
         FROM "user" u
         WHERE role NOT IN ('admin', 'support', 'creator') ${blacklist}
       )
       SELECT
         COALESCE(SUM(o.won_amount_usd::numeric), 0)::text AS wager,
         COALESCE(SUM(CASE WHEN o.result = 'win'
                           THEN v.value::numeric ELSE 0 END), 0)::text AS payout,
         COUNT(*)::text AS bets,
         COALESCE(SUM(CASE WHEN NOT ru.under_creator
                           THEN o.won_amount_usd::numeric ELSE 0 END), 0)::text
           AS organic_wager
       FROM battle_double_down_offers o
       JOIN real_users ru ON ru.id = o.user_id
       LEFT JOIN vouchers v
         ON v.id = o.won_voucher_id
        AND v.origin = 'battle_double_down_payout'
       WHERE o.result IS NOT NULL
         ${sinceClause("o.resolved_at", since)}`,
    );

    const r = rows[0];
    return {
      wager: toNumber(r?.wager),
      payout: toNumber(r?.payout),
      bets: toNumber(r?.bets),
      organicWager: toNumber(r?.organic_wager),
    };
  });
}

// ─── Reward cost (for NGR) ───────────────────────────────────────────

export type RewardCost = {
  /** Σ |amount| over REWARD_PAYOUT_TYPES EXCLUDING rain_win. */
  rewardCostExclRain: number;
  /** Σ |rain_win| over the window — for the parameterised rain hook. */
  rainWinTotal: number;
  /**
   * Σ |rain_tip| over the window — the user + founder contribution into
   * rain pools. Subtracted from `rainWinTotal` by the owner-confirmed net
   * rain model (`max(0, rain_win − rain_tip)`). `rain_tip` is RESIDUAL (a
   * transfer), surfaced here only so the NGR rain hook can net it out.
   */
  rainTipTotal: number;
};

/**
 * Read house-funded reward cost for a window, splitting `rain_win` and
 * `rain_tip` out so the NGR helper can apply the owner-confirmed net rain
 * model (see `formulas.ts` `RainHouseCost`, `{ kind: "net" }`):
 * `rainHouseCost = max(0, Σ|rain_win| − Σ|rain_tip|)`. `creator_tip` is
 * intentionally NOT summed here (it is a RESIDUAL pass-through, not a
 * reward cost).
 *
 * VOUCHER MANUAL CARVE-OUT: `voucher_redeemed` is NEUTRAL by default (see
 * `ledger-sets.ts`), so it is NOT in REWARD_PAYOUT_TYPES and the base
 * reward leg ignores it. But admin HOUSE-GRANTED vouchers
 * (`metadata->>'origin' = 'manual'`) have no earlier "grant" ledger row —
 * their only ledger touchpoint is the redemption — so for THOSE rows the
 * redemption IS the house cost and is added to `reward_excl_rain` here.
 * Every other `voucher_redeemed` row (gameplay/borrow remainders, already
 * booked at production) stays neutral — no double-count.
 *
 * CATEGORIZED ADJUSTMENT CARVE-OUT (mirrors the voucher one): an
 * `admin_balance_adjustment` is RESIDUAL by default (its type bucket is
 * unchanged), but a CREDIT carrying a COUNTED category
 * (`metadata->>'adjustment_category' IN (deposit_problem | giveaway |
 * bonus | reload | lossback)`) is a house-funded promo cost — bonus /
 * giveaway / reload / lossback / deposit-fix credits — so it is added to
 * `reward_excl_rain` here exactly like the manual voucher. `other`
 * adjustments (and corrections / manual-withdrawal debits) carry no
 * counted category, so they stay RESIDUAL — no double-count. The predicate
 * is the single canonical one from `@/lib/balance-adjustment-categories`.
 */
export async function getRewardCost(window: MetricWindow): Promise<RewardCost> {
  return withTiming("metrics.rewardCost", async () => {
    const db = await getReadDrizzleDb();
    // Same canonical scope as the gaming legs so NGR is on the SAME
    // population as GGR (staff + creators + blacklist dropped wholesale;
    // the session-window predicate is an inert no-op — see scope.ts).
    const scope = await getMetricsScope();
    const since = window.since;
    const countedAdj = countedAdjustmentSqlPredicate();

    type Row = {
      reward_excl_rain: string;
      rain_win: string;
      rain_tip: string;
    };
    const rows = await queryRows<Row[]>(db,
      `WITH ${scope.sessionWindowsCte}
       SELECT
         COALESCE(SUM(CASE
           WHEN (type::text IN ${REWARD_PAYOUT_TYPES_SQL} AND type::text <> 'rain_win')
             OR (type::text = 'voucher_redeemed' AND metadata->>'origin' = 'manual')
             OR (${countedAdj})
           THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS reward_excl_rain,
         COALESCE(SUM(CASE WHEN type::text = 'rain_win' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS rain_win,
         COALESCE(SUM(CASE WHEN type::text = 'rain_tip' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS rain_tip
       FROM ledger_transactions
       WHERE status = 'completed'
         AND user_id IN ${scope.userScopeSql}
         AND ${scope.notInCreatorSession("user_id", "created_at")}
         ${sinceClause("created_at", since)}`,
    );

    return {
      rewardCostExclRain: toNumber(rows[0]?.reward_excl_rain),
      rainWinTotal: toNumber(rows[0]?.rain_win),
      rainTipTotal: toNumber(rows[0]?.rain_tip),
    };
  });
}

// ─── Upgrader (reads upgrader_games — the GGR upgrader source) ────────

export type UpgraderMetrics = {
  wager: number;
  payout: number;
  /** GGR contribution = wager − payout (house POV). */
  ggr: number;
  bets: number;
  uniquePlayers: number;
  wins: number;
  losses: number;
  organicWager: number;
};

/**
 * Upgrader gaming metrics from the upgrader-native `upgrader_games` table
 * — the owner-confirmed source of truth (`bet_amount`, `won_amount`,
 * `user_id`), modelled on the verified `dashboard-upgrader.ts`.
 *
 * Returns `null` when the connected DB has no `upgrader_games` table (the
 * pre-upgrader snapshot) — a `to_regclass` probe makes this a graceful
 * skip rather than a `42P01` throw, the same degradation
 * `insights-streamers/_schema-probe.ts` uses.
 *
 * This is the SOURCE OF TRUTH for upgrader GGR. `getGamingLegs` /
 * `getWindowMetrics` / `getDailyGamingMetrics` fold upgrader into the
 * canonical GGR FROM HERE (upgrader is real gameplay; it is NOT in the
 * ledger, so `UPGRADER_IN_LEDGER` stays false and the ledger wager/payout
 * type sets deliberately exclude `upgrader_bet`/`upgrader_payout`). It is
 * also called directly by surfaces that want a standalone upgrader panel
 * (wins/losses/players). If prod ever starts writing `upgrader_*` to the
 * ledger, flip `UPGRADER_IN_LEDGER`, move upgrader onto the ledger type
 * sets, and source the fold from there instead — but the canonical GGR
 * already contains upgrader either way.
 */
export async function upgraderMetrics(
  window: MetricWindow,
): Promise<UpgraderMetrics | null> {
  return withTiming("metrics.upgrader", async () => {
    const db = await getReadDrizzleDb();

    // Probe: skip entirely if the table is absent (pre-upgrader DB).
    // to_regclass returns NULL (not an error) for a missing relation.
    const probe = await queryRows<{ exists: string | null }[]>(
      db,
      "SELECT to_regclass('public.upgrader_games')::text AS exists",
    );
    if (probe[0]?.exists == null) return null;

    const excluded = await getExcludedUserIds();
    const blacklist = blacklistNotInClause("id", excluded);
    const since = window.since;

    type Row = {
      wager: string;
      payout: string;
      bets: string;
      players: string;
      wins: string;
      organic_wager: string;
    };
    const rows = await queryRows<Row[]>(db,
      `WITH real_users AS (
         SELECT id,
                EXISTS (
                  SELECT 1 FROM "user" ref
                  WHERE ref.id = u.referred_by AND ref.role = 'creator'
                ) AS under_creator
         FROM "user" u
         WHERE role NOT IN ('admin', 'support', 'creator') ${blacklist}
       )
       SELECT
         COALESCE(SUM(bet_amount::numeric), 0)::text AS wager,
         COALESCE(SUM(won_amount::numeric), 0)::text AS payout,
         COUNT(*)::text AS bets,
         COUNT(DISTINCT user_id)::text AS players,
         COUNT(CASE WHEN won_amount::numeric > 0 THEN 1 END)::text AS wins,
         COALESCE(SUM(CASE WHEN NOT ru.under_creator
                           THEN ug.bet_amount::numeric ELSE 0 END), 0)::text
           AS organic_wager
       FROM upgrader_games ug
       JOIN real_users ru ON ru.id = ug.user_id
       WHERE true
         ${sinceClause("created_at", since)}`,
    );

    const r = rows[0];
    const wager = toNumber(r?.wager);
    const payout = toNumber(r?.payout);
    const bets = toNumber(r?.bets);
    const wins = toNumber(r?.wins);
    return {
      wager,
      payout,
      ggr: wager - payout,
      bets,
      uniquePlayers: toNumber(r?.players),
      wins,
      losses: Math.max(0, bets - wins),
      organicWager: toNumber(r?.organic_wager),
    };
  });
}

// ─── Composed window metrics (GGR / NGR / RTP / edge) ────────────────

export type WindowMetrics = {
  wager: number;
  /** Wager from customers without a creator-code referrer. */
  organicWager: number;
  gamingPayout: number;
  ggr: number;
  ngr: number;
  /** Empirical RTP 0..1, or null below MIN_SAMPLE. */
  rtp: EmpiricalRatio;
  /** Empirical house edge 0..1, or null below MIN_SAMPLE. */
  houseEdge: EmpiricalRatio;
  bets: number;
  /** Echo of the rain inputs used, for surfacing the assumption. */
  rainWinTotal: number;
  rainTipTotal: number;
  /** Resolved house slice of rain that reduced NGR (net model by default). */
  rainHouseCost: number;
  /** Canonical wager legs; these sum exactly to `wager`. */
  wagerBreakdown?: {
    packs: number;
    battles: number;
    keno: number;
    upgrader: number;
    doubleDown: number;
  };
};

/**
 * One call → the canonical gaming-margin metrics for a window, composing
 * the DB reads (`getGamingLegs`, `getRewardCost`) with the pure
 * `formulas.ts` arithmetic.
 *
 * `rainHouseCost` controls how rain reduces NGR (system-automatic,
 * mixed-funded). Defaults to the OWNER-CONFIRMED net model
 * `{ kind: "net", rainWinTotal, rainTipTotal }` =
 * `max(0, Σ|rain_win| − Σ|rain_tip|)`: the house only funded the winnings
 * beyond the user/founder tip contributions. Pass an explicit
 * `RainHouseCost` to override (e.g. `{ kind: "full" }` for the
 * conservative upper bound).
 *
 * Upgrader IS folded into the headline GGR by default — `getGamingLegs`
 * sources it from `upgrader_games` (real gameplay; NOT the ledger, so
 * `UPGRADER_IN_LEDGER` stays false) and merges its wager/payout/bets into
 * the legs. So headline GGR covers all five canonical game sources. There is no
 * separate upgrader read here anymore (that would double-count what the
 * legs already include).
 */
export async function getWindowMetrics(opts: {
  window: MetricWindow;
  rainHouseCost?: RainHouseCost;
}): Promise<WindowMetrics> {
  const { window } = opts;

  // One Postgres read — the gaming legs + reward legs composed with the
  // pure `formulas.ts` arithmetic.
  const [legs, reward] = await Promise.all([
    getGamingLegs(window),
    getRewardCost(window),
  ]);

  // legs already include upgrader + double down (folded in by
  // getGamingLegs). `battleRefund` carries the ledger gaming-payout legs
  // PLUS upgrader payout; `wager`/`bets` likewise include upgrader AND
  // DD. DD payout is carried on the separate `ddPayout` field so
  // `gamingPayoutTotal` sums it as its own leg (kept transparent for
  // future breakdowns). Pass them straight through — no separate term.
  const wager = legs.wager;
  const gamingPayout = gamingPayoutTotal({
    inventoryPayout: legs.inventoryPayout,
    battleRefund: legs.battleRefund,
    ddPayout: legs.ddPayout,
  });
  const bets = legs.bets;

  const ggrValue = ggrFormula({ wager, gamingPayout });
  const rainHouseCostInput: RainHouseCost =
    opts.rainHouseCost ?? {
      kind: "net",
      rainWinTotal: reward.rainWinTotal,
      rainTipTotal: reward.rainTipTotal,
    };
  const rainHouseCost = resolveRainHouseCost(rainHouseCostInput);
  const ngrValue = ngrFormula({
    ggr: ggrValue,
    rewardCostExclRain: reward.rewardCostExclRain,
    rainHouseCost: rainHouseCostInput,
  });

  return {
    wager,
    organicWager: legs.organicWager,
    wagerBreakdown: {
      packs: legs.packWager,
      battles: legs.battleWager,
      keno: legs.kenoWager,
      upgrader: legs.upgraderWager,
      doubleDown: legs.ddWager,
    },
    gamingPayout,
    ggr: ggrValue,
    ngr: ngrValue,
    rtp: empiricalRtp({ gamingPayout, wager, bets }),
    houseEdge: empiricalHouseEdge({ wager, ggr: ggrValue, bets }),
    bets,
    rainWinTotal: reward.rainWinTotal,
    rainTipTotal: reward.rainTipTotal,
    rainHouseCost,
  };
}

// ─── Daily canonical gaming-margin series ────────────────────────────

export type DailyGamingMetricPoint = {
  /** YYYY-MM-DD (UTC date of the bucket). */
  date: string;
  wager: number;
  gamingPayout: number;
  /** Canonical GGR for the day = wager − gamingPayout. */
  ggr: number;
  /** Canonical NGR for the day = GGR − reward − net rain (per-day floor). */
  ngr: number;
  /** Reward cost (excl. rain) booked on the day. */
  rewardCostExclRain: number;
  rainWinTotal: number;
  rainTipTotal: number;
};

/**
 * Per-DAY canonical gaming-margin series for a window — the daily
 * companion to `getWindowMetrics`, sharing the EXACT same type sets
 * (`ledger-sets`), the EXACT same real-customer + borrow-net-inclusive scope,
 * and the EXACT same pure formulas (`ggr`/`ngr`). This is what lets a
 * surface render a daily GGR/NGR chart that reconciles with the headline
 * by construction (Σ daily wager − Σ daily payout = headline GGR), closing
 * the historical "daily GGR set ≠ headline GGR set" bug (M2).
 *
 * Buckets:
 *  • wager / reward / rain legs bucketed by `created_at::date`
 *  • inventory payout bucketed by `obtained_at::date`
 *  • battle_refund cash leg bucketed by `created_at::date`
 *  • upgrader wager/payout (`upgrader_games`) bucketed by `created_at::date`
 * then merged per UTC date.
 *
 * Rain is netted PER DAY (`max(0, rain_win_day − rain_tip_day)`) — the
 * correct granularity because a rain pool's wins and tips settle the same
 * day. The aggregate headline (`getWindowMetrics`) floors at the window
 * level; for GGR (no floor) daily always sums to the headline exactly, and
 * for NGR the two agree unless a single day is tip-saturated (rain_tip >
 * rain_win that day), which is the same conservative house-POV treatment.
 *
 * Upgrader IS included here by default (mirroring `getGamingLegs` /
 * `getWindowMetrics`): per-day `upgrader_games.bet_amount` joins the day's
 * wager and `won_amount` joins the day's payout, so Σ daily GGR reconciles
 * with the headline across all canonical game sources. Upgrader is sourced from
 * `upgrader_games` (NOT the ledger; `UPGRADER_IN_LEDGER` stays false) and
 * is `to_regclass`-guarded — contributes 0 on a pre-upgrader DB.
 */
export async function getDailyGamingMetrics(
  window: MetricWindow,
): Promise<DailyGamingMetricPoint[]> {
  return withTiming("metrics.dailyGamingMetrics", async () => {
    const db = await getReadDrizzleDb();
    // Canonical wholesale customer scope for the ledger + inventory legs.
    const scope = await getMetricsScope();
    const since = window.since;
    const dailyEnd = new Date().toISOString();
    const countedAdj = countedAdjustmentSqlPredicate();

    // Upgrader uses the same wholesale-creator-drop scope as the shared
    // `upgraderMetrics` reader — the same population `getMetricsScope`
    // applies to the ledger/inventory legs — so the daily upgrader figure
    // here agrees with `getGamingLegs`' upgrader fold.
    const upgScope = `(SELECT id FROM "user" u WHERE u.role NOT IN ('admin', 'support', 'creator') ${blacklistNotInClause(
      "u.id",
      await getExcludedUserIds(),
    )})`;

    // Probe once: does this DB carry upgrader_games? (pre-upgrader snapshot
    // returns NULL, not an error). Gates the per-day upgrader read so it
    // degrades to 0 rather than throwing 42P01. Same probe pattern for
    // battle_double_down_offers (pre-DD snapshot).
    const [upgProbe, ddProbe] = await Promise.all([
      queryRows<{ exists: string | null }[]>(
        db,
        "SELECT to_regclass('public.upgrader_games')::text AS exists",
      ),
      queryRows<{ exists: string | null }[]>(
        db,
        "SELECT to_regclass('public.battle_double_down_offers')::text AS exists",
      ),
    ]);
    const hasUpgrader = upgProbe[0]?.exists != null;
    const hasDoubleDown = ddProbe[0]?.exists != null;

    // The day key is emitted as TEXT in SQL (`to_char(..., 'YYYY-MM-DD')`)
    // rather than re-derived in JS from a driver-parsed Date: a Postgres
    // DATE comes back as a JS Date at LOCAL midnight, so the old
    // `toISOString().slice(0, 10)` re-labelled every bucket to the
    // previous day on any process running east of UTC.
    type LedgerDayRow = {
      date: string;
      wager: string;
      battle_refund: string;
      reward_excl_rain: string;
      rain_win: string;
      rain_tip: string;
    };
    type InvDayRow = { date: string; inv_payout: string };
    type UpgDayRow = { date: string; upg_wager: string; upg_payout: string };
    type DdDayRow = { date: string; dd_wager: string; dd_payout: string };

    const [ledgerRows, invRows, upgRows, ddRows, pnlRows] = await Promise.all([
      queryRows<LedgerDayRow[]>(db,
        `WITH ${scope.sessionWindowsCte}
         SELECT
           to_char(DATE(created_at), 'YYYY-MM-DD') AS date,
           -- Per-day wager. Mirrors getGamingLegs / WAGER_LEG_FILTER exactly
           -- (borrow-net-INCLUSIVE basis — owner decision, see gaming-sql.ts):
           --  • pack_opening: counted unless a reward/daily pack
           --    (packs.pack_type='reward', ≈$0 anyway).
           --  • battle_bet: counted UNCONDITIONALLY — its amount is
           --    already net of borrow, so no borrow gate (the GAMING_PAYOUT
           --    legs below are likewise unconditional, keeping the two sides
           --    symmetric).
           --  • battle_sponsorship: counted DIRECTLY — its rows have
           --    game_session_id=NULL and all sponsored battles are
           --    borrow_percentage=0.
           COALESCE(SUM(CASE WHEN type::text IN ${WAGER_TYPES_SQL}
             AND ${WAGER_LEG_FILTER}
             THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS wager,
           -- GAMING_PAYOUT_TYPES = battle_refund + battle_excess_to_voucher
           -- (both battle-win settlement legs; field name kept for the
           -- daily merge). voucher_redeemed redemption is NEUTRAL, so the
           -- battle_excess_to_voucher win is counted once, at settlement.
           COALESCE(SUM(CASE WHEN type::text IN ${GAMING_PAYOUT_TYPES_SQL} THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_refund,
           -- Reward cost (excl rain) + the manual-voucher carve-out (admin
           -- house-granted vouchers, metadata->>'origin'='manual') + the
           -- counted-adjustment carve-out (admin_balance_adjustment credits
           -- carrying a counted category). Mirrors getRewardCost exactly so
           -- Σ daily reconciles with the headline.
           COALESCE(SUM(CASE
             WHEN (type::text IN ${REWARD_PAYOUT_TYPES_SQL} AND type::text <> 'rain_win')
               OR (type::text = 'voucher_redeemed' AND metadata->>'origin' = 'manual')
               OR (${countedAdj})
             THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS reward_excl_rain,
           COALESCE(SUM(CASE WHEN type::text = 'rain_win' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS rain_win,
           COALESCE(SUM(CASE WHEN type::text = 'rain_tip' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS rain_tip
         FROM ledger_transactions
         WHERE status = 'completed'
           AND user_id IN ${scope.userScopeSql}
           AND ${scope.notInCreatorSession("user_id", "created_at")}
           ${sinceClause("created_at", since)}
         GROUP BY DATE(created_at)`,
      ),
      queryRows<InvDayRow[]>(db,
        `WITH ${scope.sessionWindowsCte}
         SELECT
           to_char(DATE(obtained_at), 'YYYY-MM-DD') AS date,
           COALESCE(SUM(value_at_obtained::numeric), 0)::text AS inv_payout
         FROM user_inventory
         WHERE source_type IN ('pack','battle')
           AND user_id IN ${scope.userScopeSql}
           AND ${scope.notInCreatorSession("user_id", "obtained_at")}
           ${sinceClause("obtained_at", since)}
           -- Same payout-side predicate as getGamingLegs (borrow-net-
           -- inclusive: all pack/battle won cards kept, only reward-pack
           -- cards excluded) so Σ daily payout reconciles with the headline.
           -- Shared client-safe fragment → asserted by __checks__.
           AND ${PAYOUT_LEG_FILTER}
         GROUP BY DATE(obtained_at)`,
      ),
      // Per-day upgrader wager + payout from upgrader_games (real gameplay,
      // not in the ledger). Uses the wholesale-creator-drop `upgScope` to
      // match the shared `upgraderMetrics` reader (see note above).
      // Skipped (empty) on a pre-upgrader DB via the to_regclass probe.
      hasUpgrader
        ? queryRows<UpgDayRow[]>(db,
            `SELECT
               to_char(DATE(created_at), 'YYYY-MM-DD') AS date,
               COALESCE(SUM(bet_amount::numeric), 0)::text AS upg_wager,
               COALESCE(SUM(won_amount::numeric), 0)::text AS upg_payout
             FROM upgrader_games
             WHERE user_id IN ${upgScope}
               ${sinceClause("created_at", since)}
             GROUP BY DATE(created_at)`,
          )
        : Promise.resolve([] as UpgDayRow[]),
      // Per-day Double Down wager + payout from battle_double_down_offers,
      // bucketed by resolved_at (settlement time — mirrors the headline
      // fold in doubleDownLegs). Uses the same wholesale-creator-drop
      // `upgScope`. WAGER = Σ won_amount_usd over RESOLVED offers;
      // PAYOUT = Σ paired voucher `value` on wins. Skipped on a pre-DD DB.
      hasDoubleDown
        ? queryRows<DdDayRow[]>(db,
            `SELECT
               to_char(DATE(o.resolved_at), 'YYYY-MM-DD') AS date,
               COALESCE(SUM(o.won_amount_usd::numeric), 0)::text AS dd_wager,
               COALESCE(SUM(CASE WHEN o.result = 'win'
                                 THEN v.value::numeric ELSE 0 END), 0)::text AS dd_payout
             FROM battle_double_down_offers o
             LEFT JOIN vouchers v
               ON v.id = o.won_voucher_id
              AND v.origin = 'battle_double_down_payout'
             WHERE o.result IS NOT NULL
               AND o.user_id IN ${upgScope}
               ${sinceClause("o.resolved_at", since)}
             GROUP BY DATE(o.resolved_at)`,
          )
        : Promise.resolve([] as DdDayRow[]),
      getWeightedCreatorGameplayByDay({ startIso: since?.toISOString(), endIso: dailyEnd }),
    ]);

    // Merge the day-keyed sets. A day can appear in any (wager-only days,
    // inventory-payout-only days when cards from an earlier wager settle
    // later, DD-only days) — union the key space so no side is dropped.
    const byDate = new Map<
      string,
      {
        wager: number;
        battleRefund: number;
        inventoryPayout: number;
        rewardCostExclRain: number;
        rainWinTotal: number;
        rainTipTotal: number;
        ddPayout: number;
      }
    >();
    const blank = () => ({
      wager: 0,
      battleRefund: 0,
      inventoryPayout: 0,
      rewardCostExclRain: 0,
      rainWinTotal: 0,
      rainTipTotal: 0,
      ddPayout: 0,
    });
    for (const r of ledgerRows) {
      const key = r.date;
      const e = byDate.get(key) ?? blank();
      e.wager += toNumber(r.wager);
      e.battleRefund += toNumber(r.battle_refund);
      e.rewardCostExclRain += toNumber(r.reward_excl_rain);
      e.rainWinTotal += toNumber(r.rain_win);
      e.rainTipTotal += toNumber(r.rain_tip);
      byDate.set(key, e);
    }
    for (const r of invRows) {
      const key = r.date;
      const e = byDate.get(key) ?? blank();
      e.inventoryPayout += toNumber(r.inv_payout);
      byDate.set(key, e);
    }
    // Fold upgrader into the day's gaming legs: bet_amount → wager,
    // won_amount → the payout side (battleRefund), so daily GGR =
    // pack + battle + upgrader and Σ daily reconciles with the headline.
    for (const r of upgRows) {
      const key = r.date;
      const e = byDate.get(key) ?? blank();
      e.wager += toNumber(r.upg_wager);
      e.battleRefund += toNumber(r.upg_payout);
      byDate.set(key, e);
    }
    // Fold Double Down into the day's gaming legs: dd_wager → wager,
    // dd_payout → the separate `ddPayout` field (passed to
    // gamingPayoutTotal alongside battleRefund) so daily GGR =
    // pack + battle + upgrader + double-down and Σ daily reconciles with
    // the headline. Bucketed by resolved_at (same as the headline fold).
    for (const r of ddRows) {
      const key = r.date;
      const e = byDate.get(key) ?? blank();
      e.wager += toNumber(r.dd_wager);
      e.ddPayout += toNumber(r.dd_payout);
      byDate.set(key, e);
    }
    for (const r of pnlRows) {
      const e = byDate.get(r.date) ?? blank();
      e.wager += r.weightedWagerUsd;
      e.battleRefund += r.weightedPayoutUsd;
      byDate.set(r.date, e);
    }
    return [...byDate.entries()]
      .map(([date, e]) => {
        const gamingPayout = gamingPayoutTotal({
          inventoryPayout: e.inventoryPayout,
          battleRefund: e.battleRefund,
          ddPayout: e.ddPayout,
        });
        const ggrValue = ggrFormula({ wager: e.wager, gamingPayout });
        const ngrValue = ngrFormula({
          ggr: ggrValue,
          rewardCostExclRain: e.rewardCostExclRain,
          rainHouseCost: {
            kind: "net",
            rainWinTotal: e.rainWinTotal,
            rainTipTotal: e.rainTipTotal,
          },
        });
        return {
          date,
          wager: e.wager,
          gamingPayout,
          ggr: ggrValue,
          ngr: ngrValue,
          rewardCostExclRain: e.rewardCostExclRain,
          rainWinTotal: e.rainWinTotal,
          rainTipTotal: e.rainTipTotal,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));
  });
}

// ─── Ad-hoc ledger sum (escape hatch for cost-breakdown residual) ────

/**
 * Σ |amount| over an arbitrary set of ledger types for a window, through
 * the SAME canonical scope as the gaming metrics (`getMetricsScope`:
 * staff + creators + blacklist dropped wholesale).
 * Provided so cost-breakdown / residual surfaces can sum RESIDUAL_TYPES
 * (or any subset) and have their residual reconcile against GGR/NGR
 * without re-deriving the predicate. The type list is rendered via
 * `ledgerTypesToSqlList`; pass only members known to exist on the
 * connected DB (the base sets are safe; for upgrader members on a lagged
 * DB use the streamers probe instead).
 */
export async function sumLedgerTypes(opts: {
  types: readonly LedgerTransactionType[];
  window: MetricWindow;
}): Promise<number> {
  if (opts.types.length === 0) return 0;
  return withTiming("metrics.sumLedgerTypes", async () => {
    const db = await getReadDrizzleDb();
    const scope = await getMetricsScope();
    const list = ledgerTypesToSqlList(opts.types);
    type Row = { total: string };
    const rows = await queryRows<Row[]>(db,
      `WITH ${scope.sessionWindowsCte}
       SELECT COALESCE(SUM(ABS(amount::numeric)), 0)::text AS total
       FROM ledger_transactions
       WHERE status = 'completed'
         AND type::text IN ${list}
         AND (
           type::text <> 'admin_balance_adjustment'
           OR metadata->>'adjustment_category' IS DISTINCT FROM 'ultra_lossback'
         )
         AND user_id IN ${scope.userScopeSql}
         AND ${scope.notInCreatorSession("user_id", "created_at")}
         ${sinceClause("created_at", opts.window.since)}`,
    );
    return toNumber(rows[0]?.total);
  });
}

/**
 * Σ |amount| PER ledger type over a set, in ONE round-trip — the grouped
 * companion to {@link sumLedgerTypes}. Returns a `Map<type, Σ|amount|>` that
 * is BYTE-IDENTICAL to calling `sumLedgerTypes({ types: [t], window })` once
 * per `t`: the SELECT (`SUM(ABS(amount::numeric))`), the `status='completed'`
 * filter, the `type::text IN (<list>)` membership, the canonical
 * `getMetricsScope` user scope + `notInCreatorSession` predicate, and the
 * `created_at` since-clause are EXACTLY the per-type query's — only
 * `type::text` is added to the SELECT + a `GROUP BY type::text`. A type with
 * no matching rows is simply absent from the result; callers read it back as
 * `map.get(type) ?? 0`, which equals the per-type query's `COALESCE(...,0)`.
 *
 * Replaces the cost-breakdown's ~37 per-type `sumLedgerTypes` round-trips
 * (every REWARD_PAYOUT_TYPES-excl-rain member + every RESIDUAL_TYPES member)
 * with a single grouped scan — fewer round-trips, identical numbers, no
 * change to any sign/scope/window/amount expression. Same DB-existence
 * caveat as `sumLedgerTypes`: pass only members that exist on the connected
 * DB (the base sets are safe; upgrader members on a lagged DB use the
 * streamers probe instead).
 */
export async function sumLedgerTypesGrouped(opts: {
  types: readonly LedgerTransactionType[];
  window: MetricWindow;
}): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (opts.types.length === 0) return result;
  return withTiming("metrics.sumLedgerTypesGrouped", async () => {
    const db = await getReadDrizzleDb();
    const scope = await getMetricsScope();
    const list = ledgerTypesToSqlList(opts.types);
    type Row = { type: string; total: string };
    const rows = await queryRows<Row[]>(db,
      `WITH ${scope.sessionWindowsCte}
       SELECT type::text AS type, COALESCE(SUM(ABS(amount::numeric)), 0)::text AS total
       FROM ledger_transactions
       WHERE status = 'completed'
         AND type::text IN ${list}
         AND (
           type::text <> 'admin_balance_adjustment'
           OR metadata->>'adjustment_category' IS DISTINCT FROM 'ultra_lossback'
         )
         AND user_id IN ${scope.userScopeSql}
         AND ${scope.notInCreatorSession("user_id", "created_at")}
         ${sinceClause("created_at", opts.window.since)}
       GROUP BY type::text`,
    );
    for (const r of rows) {
      result.set(r.type, toNumber(r.total));
    }
    return result;
  });
}

/**
 * Σ |amount| of the FAKE-BALANCE `official_stream` `admin_balance_adjustment`
 * rows over a window, through the SAME canonical scope as the gaming metrics
 * (`getMetricsScope`). official_stream is owner-designated fake balance that
 * must be hidden everywhere: the residual `admin_balance_adjustment` line in
 * the cost-breakdown / money-flow waterfalls sums `admin_balance_adjustment`
 * via {@link sumLedgerTypes} (Σ |amount|), so this returns the matching
 * Σ |amount| slice to SUBTRACT from that residual so official_stream is not
 * surfaced as a residual admin-adjustment cost. (The COUNTED categories are
 * already carved out separately; this is the additional official_stream
 * slice.)
 */
export async function sumOfficialStreamAdjustments(opts: {
  window: MetricWindow;
}): Promise<number> {
  return withTiming("metrics.sumOfficialStreamAdjustments", async () => {
    const db = await getReadDrizzleDb();
    const scope = await getMetricsScope();
    type Row = { total: string };
    const rows = await queryRows<Row[]>(db,
      `WITH ${scope.sessionWindowsCte}
       SELECT COALESCE(SUM(ABS(amount::numeric)), 0)::text AS total
       FROM ledger_transactions
       WHERE status = 'completed'
         AND ${officialStreamAdjustmentSqlPredicate()}
         AND user_id IN ${scope.userScopeSql}
         AND ${scope.notInCreatorSession("user_id", "created_at")}
         ${sinceClause("created_at", opts.window.since)}`,
    );
    return toNumber(rows[0]?.total);
  });
}

/**
 * Σ |amount| of stats-excluded `admin_balance_adjustment` rows
 * (`official_stream`, `remove_locked_balance`) over a window, through the
 * SAME canonical scope as the gaming metrics. Subtracted from the residual
 * admin-adjustment line so neither category surfaces as a residual cost.
 */
export async function sumStatsExcludedAdjustments(opts: {
  window: MetricWindow;
}): Promise<number> {
  return withTiming("metrics.sumStatsExcludedAdjustments", async () => {
    const db = await getReadDrizzleDb();
    const scope = await getMetricsScope();
    type Row = { total: string };
    const rows = await queryRows<Row[]>(db,
      `WITH ${scope.sessionWindowsCte}
       SELECT COALESCE(SUM(ABS(amount::numeric)), 0)::text AS total
       FROM ledger_transactions
       WHERE status = 'completed'
         AND ${statsExcludedAdjustmentSqlPredicate()}
         AND user_id IN ${scope.userScopeSql}
         AND ${scope.notInCreatorSession("user_id", "created_at")}
         ${sinceClause("created_at", opts.window.since)}`,
    );
    return toNumber(rows[0]?.total);
  });
}
