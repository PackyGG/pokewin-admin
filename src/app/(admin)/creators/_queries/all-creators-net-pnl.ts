import "server-only";

import { cache } from "react";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  type DashboardPeriod,
  periodToCutoff,
} from "@/lib/queries/dashboard-period";
import {
  WAGER_TYPES_SQL,
  GAMING_PAYOUT_TYPES_SQL,
} from "@/lib/metrics/ledger-sets";
import {
  WAGER_LEG_FILTER,
  PAYOUT_LEG_FILTER,
} from "@/lib/metrics/gaming-sql";
import { getMetricsScope } from "@/lib/metrics/scope";
import { ggr as ggrFormula, gamingPayoutTotal } from "@/lib/metrics/formulas";

/**
 * all-creators-net-pnl.ts — the BATCH (all-creators) variant of the
 * canonical attribution-windowed code-user GGR, for the /creators LIST.
 *
 * This is the Term-1 (code-user GGR) side ONLY, computed for EVERY creator
 * in ONE pass. The Term-2 cost side is intentionally NOT batched here: the
 * per-creator cost (multiplier + leaderboard) is sourced from BACKEND
 * round-trips (`getCreatorTotalCost` / `getCreatorMultiplierCost` /
 * `getCreatorLeaderboardCost`), so folding it into a list of N creators
 * would fire 2·N backend calls — exactly the eager-load anti-pattern
 * CLAUDE.md's active-timeframe rule forbids. A list surface should render
 * the windowed GGR per creator and fetch the full cost breakdown lazily on
 * drill-in (the single-creator `getCreatorNetPnl`). If a list ever needs a
 * cost column, batch the cost from the backend separately (paginated) and
 * merge in code — keep this SQL pure GGR.
 *
 * ─── Attribution (same model as the single-creator path) ─────────────
 *
 * Each canonical gaming event is attributed to the creator whose code's
 * 7-day coverage window covered the user at the event time, with the
 * MOST-RECENT covering acu winning on overlap (code-hopping → latest
 * creator) and the creator's own self-attributed play dropped
 * (`referred_user_id <> affiliate_user_id`). Implemented as a per-row
 * correlated scalar subquery (`ORDER BY acu.created_at DESC LIMIT 1`) —
 * the same "most recent covering acu wins" tiebreak the existing
 * `getAllCreatorsLifetimePnl` uses for deposits — generalised from
 * deposits to ALL gaming legs (wager, ledger gaming payout, inventory
 * payout, upgrader). The source tables stay UNALIASED so the shared
 * `WAGER_LEG_FILTER` / `PAYOUT_LEG_FILTER` predicates (bare-column, with
 * their own embedded sub-selects) drop in verbatim — exactly as the
 * canonical `getGamingLegs` consumes them.
 *
 * ─── Scope + booking model (same as the canonical metric layer) ──────
 *
 * Reuses `getMetricsScope` (staff + blacklist dropped, creator-on-session
 * rows excluded symmetrically on wager + payout) and the shared
 * `WAGER_LEG_FILTER` / `PAYOUT_LEG_FILTER` borrow + reward-pack predicates
 * + the canonical type SQL — so each creator's GGR is on the SAME
 * population + booking model as the headline GGR, narrowed to their cohort.
 * Per-creator GGRs therefore sum cleanly toward (a subset of) the headline.
 *
 * Active-timeframe-only: one window per call.
 */

export type CreatorNetGgrRow = {
  creatorUserId: string;
  username: string | null;
  image: string | null;
  /** Canonical GGR for this creator's cohort over the window. */
  ggr: number;
  wager: number;
  gamingPayout: number;
  inventoryPayout: number;
  ledgerGamingPayout: number;
  upgraderWager: number;
  upgraderPayout: number;
};

/**
 * Roster-wide GGR legs — the SAME canonical components the dashboard's
 * `getGgrBreakdown` surfaces, summed across the whole creator cohort
 * (only `role = 'creator'` attributed ids — identical gate to
 * `byCreator`). These are aggregated in-loop from the per-creator
 * components already computed below, so they add NO extra query: the
 * cohort breakdown reconciles to `totalGgr` by construction
 * (`packBattleWager + upgraderWager − inventoryPayout − battleRefundLedger
 * − upgraderPayout = totalGgr`).
 *
 * Mirrors the dashboard popover's wager-side (pack/battle stake + upgrader
 * stake) and payout-side (pack/battle inventory wins + battle refunds +
 * upgrader payout) split.
 */
export type CohortGgrLegs = {
  /** Ledger pack/battle stake (upgrader carved out). Wager-side. */
  packBattleWager: number;
  /** Upgrader stake (`upgrader_games.bet_amount`). Wager-side. */
  upgraderWager: number;
  /** Pack/battle wins valued from inventory (the dominant payout). */
  inventoryPayout: number;
  /** Ledger cash gaming-payout legs — battle refunds. */
  battleRefundLedger: number;
  /** Upgrader payout (`upgrader_games.won_amount`). */
  upgraderPayout: number;
  /** Σ wager-side legs (packBattleWager + upgraderWager). */
  wagersTotal: number;
  /** Σ payout-side legs (inventoryPayout + battleRefundLedger + upgraderPayout). */
  payoutsTotal: number;
};

export type AllCreatorsNetGgr = {
  period: DashboardPeriod;
  /** Σ ggr across all creators in the result (cohort-attributed). */
  totalGgr: number;
  /**
   * Roster-wide GGR legs (wager/payout per source) summed across the
   * cohort — backs the breakdown list-down on the /creators "Net
   * Code-User GGR" tile. Reconciles to `totalGgr` by construction.
   */
  legs: CohortGgrLegs;
  /** Per-creator rows, sorted by GGR descending (biggest house win first). */
  byCreator: CreatorNetGgrRow[];
};

/**
 * Batch attribution-windowed code-user GGR for EVERY creator over a window.
 *
 * Three parallel reads, each an inner SELECT that tags every event row
 * with its covering creator (the scalar subquery above) and an outer
 * SELECT that GROUPs by it (keeping only attributed rows):
 *   • ledger wager + ledger gaming-payout legs (keyed on created_at),
 *   • inventory pack/battle payout (keyed on obtained_at),
 *   • upgrader plays (keyed on created_at) when `upgrader_games` exists,
 * merged in code into GGR = wager − gamingPayout per creator.
 *
 * The creator-on-session exclusion uses the inline-fragment form of the
 * scope (`exclStaffSessionFrag`, default bare-column) so each leg stays a
 * flat query over the UNALIASED source table. Staff + blacklist +
 * session-window drop are identical to the CTE form — they resolve from
 * the same `getMetricsScope` snapshot.
 *
 * Wrapped in React `cache()` keyed on `period` so a single page render
 * that consults it from more than one boundary (e.g. the /creators KPI
 * strip's roster-wide GGR tile + the per-row GGR merge in the grid
 * section) runs the 3 heavy ledger scans exactly ONCE per window. Same
 * per-request dedup the underlying `getMetricsScope` / `getExcludedUserIds`
 * already use; no cross-request caching, so a window's figure is always
 * recomputed on the next request.
 */
export const getAllCreatorsNetGgr = cache(async function getAllCreatorsNetGgr(
  period: DashboardPeriod,
): Promise<AllCreatorsNetGgr> {
  return withTiming("creators.allNetGgr", async () => {
    const db = await getDb();
    const scope = await getMetricsScope();
    const excluded = await getExcludedUserIds();
    const since = period === "all" ? null : periodToCutoff(period, new Date());

    const sinceClause = (col: string): string =>
      since === null ? "" : `AND ${col} >= '${since.toISOString()}'::timestamptz`;

    // Self-contained staff + blacklist + creator-on-session fragment, in
    // the DEFAULT bare-column form (`user_id` / the given ts column). The
    // source tables below are deliberately UNALIASED so the shared
    // `WAGER_LEG_FILTER` / `PAYOUT_LEG_FILTER` fragments (which reference
    // bare `type` / `game_session_id` / `source_type` / `source_id`, and
    // embed their own table-qualified sub-selects) drop in verbatim —
    // exactly as the canonical `getGamingLegs` consumes them. Aliasing the
    // outer table would force a regex rewrite that would also corrupt the
    // bare columns INSIDE those embedded sub-selects, so we don't alias.
    const exclLedger = scope.exclStaffSessionFrag({ tsCol: "created_at" });
    const exclInventory = scope.exclStaffSessionFrag({ tsCol: "obtained_at" });

    // Probe upgrader_games once — pre-upgrader snapshot returns NULL.
    const upgProbe = await db.$queryRaw<{ exists: string | null }[]>`
      SELECT to_regclass('public.upgrader_games')::text AS exists`;
    const hasUpgrader = upgProbe[0]?.exists != null;
    const upgBlacklist = blacklistNotInClause("u_ug.id", excluded);

    // Correlated scalar subquery → the covering creator for ONE event row:
    // the most-recent covering acu in the 7-day window, dropping the
    // creator's own play (`referred_user_id <> affiliate_user_id`). NULL
    // when the event falls outside every creator's coverage window.
    // `userCol` / `tsCol` are bare (unaliased) columns of the enclosing
    // table — inlined verbatim, hardcoded identifiers only.
    const coveringCreator = (userCol: string, tsCol: string): string => `(
      SELECT acu.affiliate_user_id
        FROM affiliate_code_usages acu
       WHERE acu.referred_user_id = ${userCol}
         AND acu.referred_user_id <> acu.affiliate_user_id
         AND acu.created_at <= ${tsCol}
         AND acu.created_at >= ${tsCol} - INTERVAL '7 days'
       ORDER BY acu.created_at DESC
       LIMIT 1
    )`;

    type LedgerRow = {
      creator_id: string;
      wager: string;
      ledger_payout: string;
    };
    type InvRow = { creator_id: string; inv_payout: string };
    type UpgRow = { creator_id: string; upg_wager: string; upg_payout: string };

    const [ledgerRows, invRows, upgRows] = await Promise.all([
      // Ledger wager + ledger gaming payout, attributed per covering
      // creator. Inner SELECT computes the covering creator per row over
      // the UNALIASED `ledger_transactions` (so WAGER_LEG_FILTER drops in
      // verbatim); outer GROUPs by it, keeping only attributed rows.
      db.$queryRawUnsafe<LedgerRow[]>(
        `SELECT creator_id,
                COALESCE(SUM(CASE WHEN type IN ${WAGER_TYPES_SQL} THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS wager,
                COALESCE(SUM(CASE WHEN type IN ${GAMING_PAYOUT_TYPES_SQL} THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS ledger_payout
           FROM (
             SELECT type, amount,
                    ${coveringCreator("user_id", "created_at")} AS creator_id
               FROM ledger_transactions
              WHERE status = 'completed'
                ${sinceClause("created_at")}
                AND ${WAGER_LEG_FILTER}
                ${exclLedger}
           ) attributed
          WHERE creator_id IS NOT NULL
          GROUP BY creator_id`,
      ),
      // Inventory pack/battle payout, attributed per covering creator keyed
      // on obtained_at (symmetric with the wager side). UNALIASED
      // `user_inventory` so PAYOUT_LEG_FILTER drops in verbatim.
      db.$queryRawUnsafe<InvRow[]>(
        `SELECT creator_id,
                COALESCE(SUM(value_at_obtained::numeric), 0)::text AS inv_payout
           FROM (
             SELECT value_at_obtained,
                    ${coveringCreator("user_id", "obtained_at")} AS creator_id
               FROM user_inventory
              WHERE source_type IN ('pack','battle')
                ${sinceClause("obtained_at")}
                AND ${PAYOUT_LEG_FILTER}
                ${exclInventory}
           ) attributed
          WHERE creator_id IS NOT NULL
          GROUP BY creator_id`,
      ),
      // Upgrader plays, attributed per covering creator. Wholesale-creator-
      // drop real-customer scope (matching the shared upgraderMetrics
      // reader). Skipped (empty) on a pre-upgrader DB.
      hasUpgrader
        ? db.$queryRawUnsafe<UpgRow[]>(
            `SELECT creator_id,
                    COALESCE(SUM(bet_amount::numeric), 0)::text AS upg_wager,
                    COALESCE(SUM(won_amount::numeric), 0)::text AS upg_payout
               FROM (
                 SELECT bet_amount, won_amount,
                        ${coveringCreator("user_id", "created_at")} AS creator_id
                   FROM upgrader_games
                  WHERE user_id IN (
                      SELECT u_ug.id FROM "user" u_ug
                       WHERE u_ug.role NOT IN ('admin', 'support', 'creator') ${upgBlacklist}
                    )
                    ${sinceClause("created_at")}
               ) attributed
              WHERE creator_id IS NOT NULL
              GROUP BY creator_id`,
          )
        : Promise.resolve([] as UpgRow[]),
    ]);

    // Merge the three creator-keyed sets.
    type Acc = {
      wager: number;
      ledgerGamingPayout: number;
      inventoryPayout: number;
      upgraderWager: number;
      upgraderPayout: number;
    };
    const byId = new Map<string, Acc>();
    const blank = (): Acc => ({
      wager: 0,
      ledgerGamingPayout: 0,
      inventoryPayout: 0,
      upgraderWager: 0,
      upgraderPayout: 0,
    });

    for (const r of ledgerRows) {
      const e = byId.get(r.creator_id) ?? blank();
      e.wager += toNumber(r.wager);
      e.ledgerGamingPayout += toNumber(r.ledger_payout);
      byId.set(r.creator_id, e);
    }
    for (const r of invRows) {
      const e = byId.get(r.creator_id) ?? blank();
      e.inventoryPayout += toNumber(r.inv_payout);
      byId.set(r.creator_id, e);
    }
    for (const r of upgRows) {
      const e = byId.get(r.creator_id) ?? blank();
      e.upgraderWager += toNumber(r.upg_wager);
      e.upgraderPayout += toNumber(r.upg_payout);
      byId.set(r.creator_id, e);
    }

    const emptyLegs: CohortGgrLegs = {
      packBattleWager: 0,
      upgraderWager: 0,
      inventoryPayout: 0,
      battleRefundLedger: 0,
      upgraderPayout: 0,
      wagersTotal: 0,
      payoutsTotal: 0,
    };

    if (byId.size === 0) {
      return { period, totalGgr: 0, legs: emptyLegs, byCreator: [] };
    }

    // Resolve username/image for the attributed creators (Main DB),
    // RESTRICTED to `role = 'creator'` — the attribution keys on the
    // covering acu's `affiliate_user_id`, which can be any affiliate, but
    // the /creators surface only reports CREATORS (same `cu.role =
    // 'creator'` gate the existing `getAllCreatorsLifetimePnl` applies).
    // Non-creator affiliate ids are therefore absent from the lookup and
    // skipped below. Only ids with attributed activity are looked up, so
    // the query stays small regardless of the total creator count.
    const ids = [...byId.keys()];
    const users = await db.user.findMany({
      where: { id: { in: ids }, role: "creator" },
      select: { id: true, username: true, image: true },
    });
    const userById = new Map(users.map((u) => [u.id, u]));

    // Roster-wide GGR legs — accumulated from the SAME per-creator
    // components, gated to `role = 'creator'` ids (the `if (!u) continue`
    // skip below), so the cohort breakdown sums exactly the same set the
    // tile's `totalGgr` does. `e.wager` is the ledger pack/battle stake
    // (upgrader is a separate `e.upgraderWager` slice); `e.ledgerGamingPayout`
    // is the ledger battle-refund cash leg. No extra query — pure in-loop
    // summation over the already-fetched rows.
    const legs: CohortGgrLegs = {
      packBattleWager: 0,
      upgraderWager: 0,
      inventoryPayout: 0,
      battleRefundLedger: 0,
      upgraderPayout: 0,
      wagersTotal: 0,
      payoutsTotal: 0,
    };

    let totalGgr = 0;
    const byCreator: CreatorNetGgrRow[] = [];
    for (const [creatorUserId, e] of byId) {
      const u = userById.get(creatorUserId);
      // Drop attributed ids that aren't `role = 'creator'` (non-creator
      // affiliates) — not part of the /creators surface.
      if (!u) continue;
      const wager = e.wager + e.upgraderWager;
      const gamingPayout = gamingPayoutTotal({
        inventoryPayout: e.inventoryPayout,
        battleRefund: e.ledgerGamingPayout + e.upgraderPayout,
      });
      const ggr = ggrFormula({ wager, gamingPayout });
      // Fold this creator's legs into the cohort breakdown (creator-gated,
      // same as the row push below).
      legs.packBattleWager += e.wager;
      legs.upgraderWager += e.upgraderWager;
      legs.inventoryPayout += e.inventoryPayout;
      legs.battleRefundLedger += e.ledgerGamingPayout;
      legs.upgraderPayout += e.upgraderPayout;
      byCreator.push({
        creatorUserId,
        username: u.username,
        image: u.image,
        ggr,
        wager,
        gamingPayout,
        inventoryPayout: e.inventoryPayout,
        ledgerGamingPayout: e.ledgerGamingPayout,
        upgraderWager: e.upgraderWager,
        upgraderPayout: e.upgraderPayout,
      });
      totalGgr += ggr;
    }

    // Derive the bucket totals from the accumulated legs. These mirror
    // the dashboard's `wagersTotal` / `payoutsTotal`, so
    // `wagersTotal − payoutsTotal === totalGgr` holds by construction
    // (each is the cohort sum of the same per-creator legs `totalGgr`
    // already sums).
    legs.wagersTotal = legs.packBattleWager + legs.upgraderWager;
    legs.payoutsTotal =
      legs.inventoryPayout + legs.battleRefundLedger + legs.upgraderPayout;

    // GGR descending — biggest house win first.
    byCreator.sort((a, b) => b.ggr - a.ggr);

    return { period, totalGgr, legs, byCreator };
  });
});
