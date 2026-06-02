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
  UPGRADER_IN_LEDGER,
  type LedgerTransactionType,
} from "./ledger-sets";
import {
  ggr as ggrFormula,
  ngr as ngrFormula,
  gamingPayoutTotal,
  empiricalRtp,
  empiricalHouseEdge,
  type RainHouseCost,
  type EmpiricalRatio,
} from "./formulas";

/**
 * queries.ts — documented CANONICAL query builders for the metric layer.
 *
 * Phase-1 foundation, UNWIRED. These read the Main DB (game data) and
 * return primitives. They are the DB-read companions to the pure
 * `formulas.ts` helpers: each one bakes in the canonical scope (real
 * customers, borrow-corrected, blacklist-dropped) so a migrated page
 * never re-derives a type list or a scope predicate.
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

/**
 * Real-customers scope subquery, identical in spirit to
 * `insights-games/_shared.ts` `realCustomersScopeSql` and the scope in
 * `getPackBattlePurePnl`: drops admin / support / creator and the
 * admin-managed excluded-users blacklist. Returns a `(SELECT id FROM
 * "user" …)` fragment for use as `user_id IN ${scope}`.
 *
 * Creators are dropped here (unlike lifetime realized PnL, which keeps
 * them) because gaming-margin metrics report REAL customer economics —
 * house-funded creator stream play would inflate the wager side. This is
 * the same choice `getPackBattlePurePnl` makes.
 */
async function realCustomersScope(): Promise<string> {
  const excluded = await getExcludedUserIds();
  const blacklist = blacklistNotInClause("u.id", excluded);
  return `(SELECT id FROM "user" u WHERE u.role NOT IN ('admin', 'support', 'creator') ${blacklist})`;
}

/** Inline `AND created_at >= <since>` clause, or empty for lifetime. */
function sinceClause(column: string, since: Date | null): string {
  if (since === null) return "";
  // Bind defensively as an ISO literal cast to timestamptz — `since` is a
  // server-constructed Date, never user input, but we still avoid string
  // concatenation of raw user data by formatting to ISO.
  return `AND ${column} >= '${since.toISOString()}'::timestamptz`;
}

// ─── Borrow-exclusion fragments (mirror insights-games/_shared.ts) ───
//
// Re-expressed locally as subqueries so the wager and payout builders
// stay self-contained (no CTE injection ordering to coordinate). Same
// semantics as `BORROW_FILTER_CTES`: drop pack opens tagged "borrow" in
// their description, and drop battle wagers whose battle has any
// borrow_percentage > 0 — on BOTH the wager (ledger) and payout
// (inventory) side so the two never drift.

const NON_BORROW_PACK_SESSIONS = `(
  SELECT game_session_id FROM ledger_transactions
  WHERE type = 'pack_opening' AND status = 'completed'
    AND game_session_id IS NOT NULL
    AND (description IS NULL OR description NOT ILIKE '%borrow%')
)`;

const NON_BORROW_BATTLE_SESSIONS = `(
  SELECT bp.game_session_id FROM battle_participants bp
  JOIN battles b ON b.id = bp.battle_id
  WHERE COALESCE(b.borrow_percentage, 0) = 0
)`;

// ─── Gaming legs (wager, inventory payout, battle_refund) ────────────

export type GamingLegs = {
  /** Σ |amount| over WAGER_TYPES, completed, real customers, non-borrow. */
  wager: number;
  /**
   * Σ `user_inventory.value_at_obtained` for source pack/battle, obtained
   * in window, non-borrow — the dominant pack/battle payout.
   */
  inventoryPayout: number;
  /** Σ |battle_refund| over the window — the cash gaming-payout leg. */
  battleRefund: number;
  /** COUNT of settled wager rows in the window — the empirical bet count. */
  bets: number;
};

/**
 * Read the canonical gaming legs for a window. Two parallel queries
 * (ledger wager + bet count; inventory payout) plus the battle_refund sum
 * folded into the ledger pass — exactly the structure of
 * `getPackBattlePurePnl`, generalised to a single window and with the
 * `battle_refund` cash leg added (which `getPackBattlePurePnl` omits
 * because it reports pure pack/battle gameplay only).
 *
 * Does NOT include upgrader — use `upgraderMetrics` for that (isolated
 * while `UPGRADER_IN_LEDGER` is false).
 */
export async function getGamingLegs(window: MetricWindow): Promise<GamingLegs> {
  return withTiming("metrics.gamingLegs", async () => {
    const db = await getDb();
    const scope = await realCustomersScope();
    const since = window.since;

    type LedgerRow = { wager: string; battle_refund: string; bets: string };
    type InvRow = { inv_payout: string };

    const [ledger, inv] = await Promise.all([
      db.$queryRawUnsafe<LedgerRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN type IN ${WAGER_TYPES_SQL} THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS wager,
           COALESCE(SUM(CASE WHEN type IN ${GAMING_PAYOUT_TYPES_SQL} THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_refund,
           COALESCE(SUM(CASE WHEN type IN ${WAGER_TYPES_SQL} THEN 1 ELSE 0 END), 0)::text AS bets
         FROM ledger_transactions
         WHERE status = 'completed'
           AND user_id IN ${scope}
           ${sinceClause("created_at", since)}
           -- Borrow exclusion on the wager side (battle_refund is a cash
           -- winner leg; it carries no borrow flag of its own, so it is
           -- summed unconditionally within the type filter above).
           AND (
             type NOT IN ('pack_opening','battle_bet','battle_sponsorship')
             OR (type = 'pack_opening' AND (description IS NULL OR description NOT ILIKE '%borrow%'))
             OR (type IN ('battle_bet','battle_sponsorship') AND game_session_id IN ${NON_BORROW_BATTLE_SESSIONS})
           )`,
      ),
      db.$queryRawUnsafe<InvRow[]>(
        `SELECT
           COALESCE(SUM(value_at_obtained::numeric), 0)::text AS inv_payout
         FROM user_inventory
         WHERE source_type IN ('pack','battle')
           AND user_id IN ${scope}
           ${sinceClause("obtained_at", since)}
           AND (
             (source_type = 'pack' AND source_id IN ${NON_BORROW_PACK_SESSIONS})
             OR (source_type = 'battle' AND source_id IN ${NON_BORROW_BATTLE_SESSIONS})
           )`,
      ),
    ]);

    return {
      wager: toNumber(ledger[0]?.wager),
      battleRefund: toNumber(ledger[0]?.battle_refund),
      bets: toNumber(ledger[0]?.bets),
      inventoryPayout: toNumber(inv[0]?.inv_payout),
    };
  });
}

// ─── Reward cost (for NGR) ───────────────────────────────────────────

export type RewardCost = {
  /** Σ |amount| over REWARD_PAYOUT_TYPES EXCLUDING rain_win. */
  rewardCostExclRain: number;
  /** Σ |rain_win| over the window — for the parameterised rain hook. */
  rainWinTotal: number;
};

/**
 * Read house-funded reward cost for a window, splitting `rain_win` out so
 * the NGR helper can apply the mixed-funding rain hook (see `formulas.ts`
 * `RainHouseCost`). `creator_tip` is intentionally NOT summed here (it is
 * a RESIDUAL pass-through, not a reward cost).
 */
export async function getRewardCost(window: MetricWindow): Promise<RewardCost> {
  return withTiming("metrics.rewardCost", async () => {
    const db = await getDb();
    const scope = await realCustomersScope();
    const since = window.since;

    type Row = { reward_excl_rain: string; rain_win: string };
    const rows = await db.$queryRawUnsafe<Row[]>(
      `SELECT
         COALESCE(SUM(CASE WHEN type IN ${REWARD_PAYOUT_TYPES_SQL} AND type <> 'rain_win' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS reward_excl_rain,
         COALESCE(SUM(CASE WHEN type = 'rain_win' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS rain_win
       FROM ledger_transactions
       WHERE status = 'completed'
         AND user_id IN ${scope}
         ${sinceClause("created_at", since)}`,
    );

    return {
      rewardCostExclRain: toNumber(rows[0]?.reward_excl_rain),
      rainWinTotal: toNumber(rows[0]?.rain_win),
    };
  });
}

// ─── Upgrader (ISOLATED — reads upgrader_games; prod-confirm pending) ─

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
 * This is the ISOLATED upgrader path used while `UPGRADER_IN_LEDGER` is
 * `false`. When prod confirms the ledger carries `upgrader_payout` (the
 * `SELECT count(*) … WHERE type='upgrader_payout' > 0` check) and the flag
 * flips, upgrader should instead be folded into `getGamingLegs` via the
 * `*_WITH_UPGRADER` type unions and this separate read retired.
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
  /** Echo of the rain treatment used, for surfacing the assumption. */
  rainWinTotal: number;
};

/**
 * One call → the canonical gaming-margin metrics for a window, composing
 * the DB reads (`getGamingLegs`, `getRewardCost`, and — when the table
 * exists — `upgraderMetrics`) with the pure `formulas.ts` arithmetic.
 *
 * `rainHouseCost` controls how rain reduces NGR (mixed-funded). Defaults
 * to the CONSERVATIVE `{ kind: "full" }` (all `rain_win` counts as house
 * cost) — an upper bound until a prod funding signal lets us net out
 * user-funded `rain_tip`. Pass an explicit `RainHouseCost` to override.
 *
 * Upgrader is folded into wager/payout ONLY when `UPGRADER_IN_LEDGER` is
 * true (post prod-confirm). While false, upgrader is reported separately
 * via `upgraderMetrics` and is NOT mixed into these gaming-margin
 * numbers — keeping the contradiction isolated.
 */
export async function getWindowMetrics(opts: {
  window: MetricWindow;
  rainHouseCost?: RainHouseCost;
}): Promise<WindowMetrics> {
  const { window } = opts;
  const [legs, reward, upg] = await Promise.all([
    getGamingLegs(window),
    getRewardCost(window),
    UPGRADER_IN_LEDGER ? Promise.resolve(null) : upgraderMetrics(window),
  ]);

  // Upgrader is only mixed into the gaming-margin headline when the
  // ledger is the source of truth (post-flip). While isolated, its
  // contribution here is 0 and it is surfaced via upgraderMetrics().
  const upgraderPayout = UPGRADER_IN_LEDGER && upg ? upg.payout : 0;
  const upgraderWager = UPGRADER_IN_LEDGER && upg ? upg.wager : 0;
  const upgraderBets = UPGRADER_IN_LEDGER && upg ? upg.bets : 0;

  const wager = legs.wager + upgraderWager;
  const gamingPayout = gamingPayoutTotal({
    inventoryPayout: legs.inventoryPayout,
    battleRefund: legs.battleRefund,
    upgraderPayout,
  });
  const bets = legs.bets + upgraderBets;

  const ggrValue = ggrFormula({ wager, gamingPayout });
  const rainHouseCost: RainHouseCost =
    opts.rainHouseCost ?? { kind: "full", rainWinTotal: reward.rainWinTotal };
  const ngrValue = ngrFormula({
    ggr: ggrValue,
    rewardCostExclRain: reward.rewardCostExclRain,
    rainHouseCost,
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
  };
}

// ─── Ad-hoc ledger sum (escape hatch for cost-breakdown residual) ────

/**
 * Σ |amount| over an arbitrary set of ledger types for a window + real-
 * customer scope. Provided so cost-breakdown / residual surfaces can sum
 * RESIDUAL_TYPES (or any subset) through the SAME scope as the gaming
 * metrics without re-deriving the predicate. The type list is rendered
 * via `ledgerTypesToSqlList`; pass only members known to exist on the
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
    const scope = await realCustomersScope();
    const list = ledgerTypesToSqlList(opts.types);
    type Row = { total: string };
    const rows = await db.$queryRawUnsafe<Row[]>(
      `SELECT COALESCE(SUM(ABS(amount::numeric)), 0)::text AS total
       FROM ledger_transactions
       WHERE status = 'completed'
         AND type IN ${list}
         AND user_id IN ${scope}
         ${sinceClause("created_at", opts.window.since)}`,
    );
    return toNumber(rows[0]?.total);
  });
}
