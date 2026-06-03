import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  WAGER_TYPES_SQL,
  GAMING_PAYOUT_TYPES_SQL,
  REWARD_PAYOUT_TYPES_SQL,
  ledgerTypesToSqlList,
  type LedgerTransactionType,
} from "./ledger-sets";
import { countedAdjustmentSqlPredicate } from "@/lib/balance-adjustment-categories";
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
  NON_BORROW_BATTLE_SESSIONS,
  REWARD_PACK_SESSIONS,
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
 * canonical scope (real customers, borrow-corrected, blacklist-dropped) so
 * a consuming page never re-derives a type list or a scope predicate.
 *
 * The wager/payout shape deliberately matches
 * `src/lib/queries/pnl.ts` `getPackBattlePurePnl` (pnl.ts:749-945):
 *   • wager  ← ledger `pack_opening` / `battle_bet` / `battle_sponsorship`
 *   • payout ← `user_inventory.value_at_obtained`,
 *              `source_type IN ('pack','battle')`, by `obtained_at`
 *              + `|battle_refund|` cash leg
 * with borrow plays excluded on BOTH sides. Study that function before
 * touching this — they must agree.
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
// (`getMetricsScope`): staff + blacklist dropped, creators KEPT, and
// creator-on-session rows excluded per-row via a session-window predicate
// (NOT a blunt role drop). It is EXPORTED so the dashboard / analytics
// hand-rolled scopes can be swept onto it ("one scope, fixed once"). The
// builders below consume it; the old wholesale-creator-drop
// `realCustomersScope` helper has been removed.

/** Inline `AND created_at >= <since>` clause, or empty for lifetime. */
function sinceClause(column: string, since: Date | null): string {
  if (since === null) return "";
  // Bind defensively as an ISO literal cast to timestamptz — `since` is a
  // server-constructed Date, never user input, but we still avoid string
  // concatenation of raw user data by formatting to ISO.
  return `AND ${column} >= '${since.toISOString()}'::timestamptz`;
}

// ─── Borrow + reward-pack exclusion fragments ────────────────────────
//
// The pure SQL fragments (`NON_BORROW_*_SESSIONS`, `REWARD_PACK_SESSIONS`)
// and the composed wager/payout predicates (`WAGER_LEG_FILTER` /
// `PAYOUT_LEG_FILTER`) live in the client-safe `./gaming-sql` module so
// the pure `__checks__` can assert their shape without the DB. They encode
// the two owner-confirmed fixes:
//   • Fix 1 — `battle_sponsorship` is counted as customer WAGER directly
//     (no borrow gate; its `game_session_id` is NULL, all sponsored
//     battles are borrow_percentage=0). `battle_bet` keeps the gate.
//   • Fix 2 — reward/daily packs (`packs.pack_type='reward'`) are dropped
//     from BOTH the wager and the won-card inventory legs (a giveaway
//     tracked as a reward cost in `/insights/rewards`, not gaming).
// Same `BORROW_FILTER_CTES` borrow semantics as insights-games/_shared.ts;
// the reward-pack join mirrors insights-rewards/daily-packs.ts.

// ─── Gaming legs (wager, inventory payout, ledger gaming payout) ─────

export type GamingLegs = {
  /**
   * Σ wager for the window, real customers, non-borrow — pack/battle
   * ledger WAGER_TYPES PLUS upgrader (`Σ upgrader_games.bet_amount`).
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
   * in window, non-borrow — the dominant pack/battle payout. (Upgrader
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
};

/**
 * Read the canonical gaming legs for a window. Three parallel reads:
 *   • ledger wager (WAGER_TYPES, borrow-corrected) + bet count + the
 *     ledger gaming-payout sum (`battle_refund` + `battle_excess_to_voucher`
 *     over GAMING_PAYOUT_TYPES),
 *   • inventory payout (the dominant pack/battle win delta),
 *   • upgrader (`upgrader_games` via `upgraderMetrics`).
 *
 * Upgrader is FOLDED IN BY DEFAULT — its wager joins `wager`, its payout
 * joins `battleRefund`, its bets join `bets` — so the canonical GGR
 * (`getWindowMetrics`) and the dashboard GGR breakdown (which both read
 * these legs) cover pack + battle + upgrader. Upgrader is sourced from
 * `upgrader_games` (NOT the ledger; `UPGRADER_IN_LEDGER` stays false) and
 * is `to_regclass`-guarded, contributing 0 on a pre-upgrader DB. The
 * upgrader-only slices are also returned separately (`upgraderWager` /
 * `upgraderPayout` / `upgraderBets`) for transparent breakdowns.
 */
export async function getGamingLegs(window: MetricWindow): Promise<GamingLegs> {
  return withTiming("metrics.gamingLegs", async () => {
    const db = await getDb();
    // Canonical scope: staff + blacklist dropped, creators KEPT, with
    // creator-on-session rows excluded per-row via the session-window
    // predicate (symmetric on wager + payout). See scope.ts.
    const scope = await getMetricsScope();
    const since = window.since;

    type LedgerRow = { wager: string; battle_refund: string; bets: string };
    type InvRow = { inv_payout: string };

    const [ledger, inv, upg] = await Promise.all([
      db.$queryRawUnsafe<LedgerRow[]>(
        `WITH ${scope.sessionWindowsCte}
         SELECT
           COALESCE(SUM(CASE WHEN type IN ${WAGER_TYPES_SQL} THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS wager,
           COALESCE(SUM(CASE WHEN type IN ${GAMING_PAYOUT_TYPES_SQL} THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_refund,
           COALESCE(SUM(CASE WHEN type IN ${WAGER_TYPES_SQL} THEN 1 ELSE 0 END), 0)::text AS bets
         FROM ledger_transactions
         WHERE status = 'completed'
           AND user_id IN ${scope.userScopeSql}
           AND ${scope.notInCreatorSession("user_id", "created_at")}
           ${sinceClause("created_at", since)}
           -- Wager-side borrow + reward-pack exclusion (Fix 1 + Fix 2),
           -- from the shared client-safe predicate so the pure __checks__
           -- assert its exact shape. battle_sponsorship is counted
           -- DIRECTLY (no borrow gate — its game_session_id is NULL, all
           -- sponsored battles are borrow_percentage=0); battle_bet stays
           -- borrow-gated; reward/daily packs (pack_type='reward', ≈$0) are
           -- dropped. The GAMING_PAYOUT legs (battle_refund +
           -- battle_excess_to_voucher) carry no borrow flag and are summed
           -- unconditionally within their type filter above.
           AND ${WAGER_LEG_FILTER}`,
      ),
      db.$queryRawUnsafe<InvRow[]>(
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
           -- Payout-side borrow + reward-pack exclusion (Fix 2 is the
           -- material leg): non-borrow pack/battle, then reward/daily-pack
           -- won cards dropped (keyed on source_id = originating
           -- game_session_id) so the giveaway is not counted as a gaming
           -- payout. Shared predicate → asserted by __checks__.
           AND ${PAYOUT_LEG_FILTER}`,
      ),
      // Upgrader from upgrader_games (real gameplay, not in the ledger).
      // `null` on a pre-upgrader DB (to_regclass guard) → contributes 0.
      // NOTE: upgraderMetrics uses the wholesale-creator-drop scope (a
      // shared reader also used by insights-games); the ledger/inventory
      // legs above use the session-window scope. So creator OFF-session
      // packs/battles count but creator upgrader never does — a documented
      // minor asymmetry (upgrader is a smaller product line and the shared
      // reader is intentionally left untouched).
      upgraderMetrics(window),
    ]);

    const ledgerWager = toNumber(ledger[0]?.wager);
    const ledgerGamingPayout = toNumber(ledger[0]?.battle_refund);
    const ledgerBets = toNumber(ledger[0]?.bets);
    const inventoryPayout = toNumber(inv[0]?.inv_payout);

    const upgraderWager = upg?.wager ?? 0;
    const upgraderPayout = upg?.payout ?? 0;
    const upgraderBets = upg?.bets ?? 0;

    return {
      // Upgrader folded into the headline legs by default.
      wager: ledgerWager + upgraderWager,
      battleRefund: ledgerGamingPayout + upgraderPayout,
      bets: ledgerBets + upgraderBets,
      inventoryPayout,
      // Upgrader-only slices (already included above; do not re-add).
      upgraderWager,
      upgraderPayout,
      upgraderBets,
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
    const db = await getDb();
    // Same canonical session-window scope as the gaming legs so NGR is on
    // the SAME population as GGR (staff + blacklist dropped, creators kept,
    // creator-on-session reward rows excluded).
    const scope = await getMetricsScope();
    const since = window.since;
    const countedAdj = countedAdjustmentSqlPredicate();

    type Row = {
      reward_excl_rain: string;
      rain_win: string;
      rain_tip: string;
    };
    const rows = await db.$queryRawUnsafe<Row[]>(
      `WITH ${scope.sessionWindowsCte}
       SELECT
         COALESCE(SUM(CASE
           WHEN (type IN ${REWARD_PAYOUT_TYPES_SQL} AND type <> 'rain_win')
             OR (type = 'voucher_redeemed' AND metadata->>'origin' = 'manual')
             OR (${countedAdj})
           THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS reward_excl_rain,
         COALESCE(SUM(CASE WHEN type = 'rain_win' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS rain_win,
         COALESCE(SUM(CASE WHEN type = 'rain_tip' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS rain_tip
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
    const db = await getDb();

    // Probe: skip entirely if the table is absent (pre-upgrader DB).
    // to_regclass returns NULL (not an error) for a missing relation.
    const probe = await db.$queryRaw<{ exists: string | null }[]>`
      SELECT to_regclass('public.upgrader_games')::text AS exists`;
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
    };
    const rows = await db.$queryRawUnsafe<Row[]>(
      `WITH real_users AS (
         SELECT id FROM "user"
         WHERE role NOT IN ('admin', 'support', 'creator') ${blacklist}
       )
       SELECT
         COALESCE(SUM(bet_amount::numeric), 0)::text AS wager,
         COALESCE(SUM(won_amount::numeric), 0)::text AS payout,
         COUNT(*)::text AS bets,
         COUNT(DISTINCT user_id)::text AS players,
         COUNT(CASE WHEN won_amount::numeric > 0 THEN 1 END)::text AS wins
       FROM upgrader_games
       WHERE user_id IN (SELECT id FROM real_users)
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
    };
  });
}

// ─── Composed window metrics (GGR / NGR / RTP / edge) ────────────────

export type WindowMetrics = {
  wager: number;
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
 * the legs. So headline GGR = pack + battle + upgrader. There is no
 * separate upgrader read here anymore (that would double-count what the
 * legs already include).
 */
export async function getWindowMetrics(opts: {
  window: MetricWindow;
  rainHouseCost?: RainHouseCost;
}): Promise<WindowMetrics> {
  const { window } = opts;
  const [legs, reward] = await Promise.all([
    getGamingLegs(window),
    getRewardCost(window),
  ]);

  // legs already include upgrader (folded in by getGamingLegs from
  // upgrader_games). `battleRefund` carries the ledger gaming-payout legs
  // PLUS upgrader payout; `wager`/`bets` likewise include upgrader. So we
  // pass them straight through — no separate upgrader term here.
  const wager = legs.wager;
  const gamingPayout = gamingPayoutTotal({
    inventoryPayout: legs.inventoryPayout,
    battleRefund: legs.battleRefund,
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
 * (`ledger-sets`), the EXACT same real-customer + borrow-corrected scope,
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
 * with the headline (pack + battle + upgrader). Upgrader is sourced from
 * `upgrader_games` (NOT the ledger; `UPGRADER_IN_LEDGER` stays false) and
 * is `to_regclass`-guarded — contributes 0 on a pre-upgrader DB.
 */
export async function getDailyGamingMetrics(
  window: MetricWindow,
): Promise<DailyGamingMetricPoint[]> {
  return withTiming("metrics.dailyGamingMetrics", async () => {
    const db = await getDb();
    // Canonical session-window scope for the ledger + inventory legs.
    const scope = await getMetricsScope();
    const since = window.since;
    const countedAdj = countedAdjustmentSqlPredicate();

    // Upgrader uses the wholesale-creator-drop scope (matching the shared
    // `upgraderMetrics` reader), so the daily upgrader figure here agrees
    // with `getGamingLegs`' upgrader fold. (Same documented asymmetry as
    // getGamingLegs: creator upgrader is dropped wholesale while creator
    // off-session packs/battles count.)
    const upgScope = `(SELECT id FROM "user" u WHERE u.role NOT IN ('admin', 'support', 'creator') ${blacklistNotInClause(
      "u.id",
      await getExcludedUserIds(),
    )})`;

    // Probe once: does this DB carry upgrader_games? (pre-upgrader snapshot
    // returns NULL, not an error). Gates the per-day upgrader read so it
    // degrades to 0 rather than throwing 42P01.
    const upgProbe = await db.$queryRaw<{ exists: string | null }[]>`
      SELECT to_regclass('public.upgrader_games')::text AS exists`;
    const hasUpgrader = upgProbe[0]?.exists != null;

    type LedgerDayRow = {
      date: Date;
      wager: string;
      battle_refund: string;
      reward_excl_rain: string;
      rain_win: string;
      rain_tip: string;
    };
    type InvDayRow = { date: Date; inv_payout: string };
    type UpgDayRow = { date: Date; upg_wager: string; upg_payout: string };

    const [ledgerRows, invRows, upgRows] = await Promise.all([
      db.$queryRawUnsafe<LedgerDayRow[]>(
        `WITH ${scope.sessionWindowsCte}
         SELECT
           DATE(created_at) AS date,
           -- Per-day wager. Mirrors getGamingLegs exactly:
           --  • pack_opening: non-borrow AND NOT a reward/daily pack
           --    (packs.pack_type='reward', ≈$0 anyway) — Fix 2.
           --  • battle_bet: borrow-gated by its game_session.
           --  • battle_sponsorship: counted DIRECTLY (no borrow gate) — its
           --    rows have game_session_id=NULL so the IN-gate would drop
           --    them (the GGR-omits-sponsorship bug); all sponsored battles
           --    are borrow_percentage=0, so no gate is needed — Fix 1.
           COALESCE(SUM(CASE WHEN type IN ${WAGER_TYPES_SQL}
             AND (
               (type = 'pack_opening'
                AND (description IS NULL OR description NOT ILIKE '%borrow%')
                AND (game_session_id IS NULL OR game_session_id NOT IN ${REWARD_PACK_SESSIONS}))
               OR (type = 'battle_bet' AND game_session_id IN ${NON_BORROW_BATTLE_SESSIONS})
               OR type = 'battle_sponsorship'
             )
             THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS wager,
           -- GAMING_PAYOUT_TYPES = battle_refund + battle_excess_to_voucher
           -- (both battle-win settlement legs; field name kept for the
           -- daily merge). voucher_redeemed redemption is NEUTRAL, so the
           -- battle_excess_to_voucher win is counted once, at settlement.
           COALESCE(SUM(CASE WHEN type IN ${GAMING_PAYOUT_TYPES_SQL} THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_refund,
           -- Reward cost (excl rain) + the manual-voucher carve-out (admin
           -- house-granted vouchers, metadata->>'origin'='manual') + the
           -- counted-adjustment carve-out (admin_balance_adjustment credits
           -- carrying a counted category). Mirrors getRewardCost exactly so
           -- Σ daily reconciles with the headline.
           COALESCE(SUM(CASE
             WHEN (type IN ${REWARD_PAYOUT_TYPES_SQL} AND type <> 'rain_win')
               OR (type = 'voucher_redeemed' AND metadata->>'origin' = 'manual')
               OR (${countedAdj})
             THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS reward_excl_rain,
           COALESCE(SUM(CASE WHEN type = 'rain_win' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS rain_win,
           COALESCE(SUM(CASE WHEN type = 'rain_tip' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS rain_tip
         FROM ledger_transactions
         WHERE status = 'completed'
           AND user_id IN ${scope.userScopeSql}
           AND ${scope.notInCreatorSession("user_id", "created_at")}
           ${sinceClause("created_at", since)}
         GROUP BY DATE(created_at)`,
      ),
      db.$queryRawUnsafe<InvDayRow[]>(
        `WITH ${scope.sessionWindowsCte}
         SELECT
           DATE(obtained_at) AS date,
           COALESCE(SUM(value_at_obtained::numeric), 0)::text AS inv_payout
         FROM user_inventory
         WHERE source_type IN ('pack','battle')
           AND user_id IN ${scope.userScopeSql}
           AND ${scope.notInCreatorSession("user_id", "obtained_at")}
           ${sinceClause("obtained_at", since)}
           -- Same payout-side predicate as getGamingLegs (non-borrow +
           -- reward-pack exclusion, Fix 2) so Σ daily payout reconciles
           -- with the headline. Shared client-safe fragment → asserted by
           -- __checks__.
           AND ${PAYOUT_LEG_FILTER}
         GROUP BY DATE(obtained_at)`,
      ),
      // Per-day upgrader wager + payout from upgrader_games (real gameplay,
      // not in the ledger). Uses the wholesale-creator-drop `upgScope` to
      // match the shared `upgraderMetrics` reader (see note above).
      // Skipped (empty) on a pre-upgrader DB via the to_regclass probe.
      hasUpgrader
        ? db.$queryRawUnsafe<UpgDayRow[]>(
            `SELECT
               DATE(created_at) AS date,
               COALESCE(SUM(bet_amount::numeric), 0)::text AS upg_wager,
               COALESCE(SUM(won_amount::numeric), 0)::text AS upg_payout
             FROM upgrader_games
             WHERE user_id IN ${upgScope}
               ${sinceClause("created_at", since)}
             GROUP BY DATE(created_at)`,
          )
        : Promise.resolve([] as UpgDayRow[]),
    ]);

    // Merge the two day-keyed sets. A day can appear in either (wager-only
    // days, or inventory-payout-only days when cards from an earlier wager
    // settle later) — union the key space so neither side is dropped.
    const byDate = new Map<
      string,
      {
        wager: number;
        battleRefund: number;
        inventoryPayout: number;
        rewardCostExclRain: number;
        rainWinTotal: number;
        rainTipTotal: number;
      }
    >();
    const blank = () => ({
      wager: 0,
      battleRefund: 0,
      inventoryPayout: 0,
      rewardCostExclRain: 0,
      rainWinTotal: 0,
      rainTipTotal: 0,
    });
    const dayKey = (d: Date) => new Date(d).toISOString().slice(0, 10);

    for (const r of ledgerRows) {
      const key = dayKey(r.date);
      const e = byDate.get(key) ?? blank();
      e.wager += toNumber(r.wager);
      e.battleRefund += toNumber(r.battle_refund);
      e.rewardCostExclRain += toNumber(r.reward_excl_rain);
      e.rainWinTotal += toNumber(r.rain_win);
      e.rainTipTotal += toNumber(r.rain_tip);
      byDate.set(key, e);
    }
    for (const r of invRows) {
      const key = dayKey(r.date);
      const e = byDate.get(key) ?? blank();
      e.inventoryPayout += toNumber(r.inv_payout);
      byDate.set(key, e);
    }
    // Fold upgrader into the day's gaming legs: bet_amount → wager,
    // won_amount → the payout side (battleRefund), so daily GGR =
    // pack + battle + upgrader and Σ daily reconciles with the headline.
    for (const r of upgRows) {
      const key = dayKey(r.date);
      const e = byDate.get(key) ?? blank();
      e.wager += toNumber(r.upg_wager);
      e.battleRefund += toNumber(r.upg_payout);
      byDate.set(key, e);
    }

    return [...byDate.entries()]
      .map(([date, e]) => {
        const gamingPayout = gamingPayoutTotal({
          inventoryPayout: e.inventoryPayout,
          battleRefund: e.battleRefund,
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
 * the SAME canonical scope as the gaming metrics (`getMetricsScope`: staff
 * + blacklist dropped, creators kept, creator-on-session rows excluded).
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
    const db = await getDb();
    const scope = await getMetricsScope();
    const list = ledgerTypesToSqlList(opts.types);
    type Row = { total: string };
    const rows = await db.$queryRawUnsafe<Row[]>(
      `WITH ${scope.sessionWindowsCte}
       SELECT COALESCE(SUM(ABS(amount::numeric)), 0)::text AS total
       FROM ledger_transactions
       WHERE status = 'completed'
         AND type IN ${list}
         AND user_id IN ${scope.userScopeSql}
         AND ${scope.notInCreatorSession("user_id", "created_at")}
         ${sinceClause("created_at", opts.window.since)}`,
    );
    return toNumber(rows[0]?.total);
  });
}
