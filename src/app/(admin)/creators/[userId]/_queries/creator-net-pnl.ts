import "server-only";

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

import { creatorAttributionExists } from "../../_queries/creator-attribution-sql";
import { getCreatorLeaderboardCost } from "./leaderboard-cost-by-creator";
import { getCreatorMultiplierCost } from "./multiplier-cost-by-creator";

/**
 * creator-net-pnl.ts — the CANONICAL, ADDITIVE "Net Creator P&L + total
 * cost" foundation for a SINGLE creator, window-scoped.
 *
 * ADDITIVE: the existing `getCreatorPnl` (`deposits − cardWithdrawals`,
 * gross/lifetime) in `src/lib/queries/creators-pnl.ts` and
 * `getAllCreatorsLifetimePnl` are left intact — the live page keeps using
 * them. This builds the CORRECT model alongside them; a later page-rework
 * agent switches the surfaces over.
 *
 * ─── THE MODEL ───────────────────────────────────────────────────────
 *
 *   netPnl = codeUserGgr − totalCost
 *
 * where:
 *
 *   • codeUserGgr — the canonical real-money gaming margin
 *     (`wager − gamingPayout`, house POV) of the creator's CODE COHORT
 *     over the window, attributed event-by-event via the 7-day coverage
 *     window (most-recent covering acu wins; the creator's own
 *     self-attributed play is dropped). REUSES the canonical metric-layer
 *     predicates (`WAGER_LEG_FILTER` / `PAYOUT_LEG_FILTER` from
 *     `gaming-sql`, the type SQL from `ledger-sets`) and the canonical
 *     scope (`getMetricsScope`: staff + blacklist dropped, creator-on-
 *     session rows excluded symmetrically). So the per-creator GGR is on
 *     the SAME population + booking model as the headline dashboard / /ggr
 *     GGR, just narrowed to one creator's cohort. See
 *     `creator-attribution-sql.ts` for the attribution predicate.
 *
 *   • totalCost — the house's total spend ON this creator (see
 *     `getCreatorTotalCost` below): fill-voucher payouts + net fill +
 *     leaderboard prize cost, with referral commission exposed as a
 *     SEPARATE sub-term (NOT folded into the default total — the owner
 *     decides whether commission counts as creator cost).
 *
 * HOUSE POV (per CLAUDE.md):
 *   • codeUserGgr > 0 → cohort lost money to us → 🟢 emerald.
 *   • totalCost is always a house outflow → 🔴 rose.
 *   • netPnl > 0 (emerald): the cohort's gaming margin covered what we
 *     spent on the creator. netPnl < 0 (rose): we spent more on the
 *     creator than their cohort returned.
 *
 * Active-timeframe-only: one window per call (the caller passes the active
 * `?period=`). Nothing is pre-computed across windows.
 */

// ─── Cost shape ──────────────────────────────────────────────────────

export type CreatorCostBreakdown = {
  /**
   * Σ `withdrawable_voucher_usd` over the creator's multiplier deals
   * (`creator_multiplier_payout` / `creator_fill_conversion`). The
   * withdrawable payout voucher issued at end-of-stream settlement.
   * Sourced from `getCreatorMultiplierCost` (`payoutUsd`).
   */
  fillPayouts: number;
  /**
   * Σ `(platform_funding_usd − fill_refunded_usd)` — the net house fill
   * funded across the creator's multiplier deals (= `creator_fill_activation`
   * − `creator_fill_refund`, which already ABSORBS the house-funded
   * `creator_fill_spend_tip` / `creator_fill_spend_battle`). Sourced from
   * `getCreatorMultiplierCost` (`netFillUsd`).
   */
  netFill: number;
  /**
   * Σ `(prize − refund) × house%` over the creator's APPROVED affiliate
   * leaderboards. Sourced from `getCreatorLeaderboardCost`.
   *
   * NOTE (claimed-vs-committed): this is the COMMITTED pool weighted by
   * the sponsored %, NOT the manually-CLAIMED prize total. See the module
   * doc on `getCreatorTotalCost` for the prod re-check.
   */
  leaderboardCost: number;
  /**
   * Referral commission paid to the creator
   * (`affiliate_accounts.total_paid_out_usd`, lifetime). Exposed as a
   * SEPARATE sub-term and NOT included in `total` by default — the owner
   * decides whether referral commission counts as creator cost or a
   * separate line. `null` when the creator has no affiliate account.
   */
  commission: number | null;
};

export type CreatorTotalCost = {
  /**
   * Default total creator cost = fillPayouts + netFill + leaderboardCost.
   * Commission is DELIBERATELY excluded (see `breakdown.commission`).
   */
  total: number;
  /**
   * `total + commission` — the total WITH referral commission folded in,
   * for the surface that wants the commission-inclusive figure. Equals
   * `total` when the creator has no affiliate account.
   */
  totalWithCommission: number;
  breakdown: CreatorCostBreakdown;
  /**
   * True when at least one cost source failed to load (the failed bucket
   * contributed 0), so `total` is a LOWER BOUND. The surface can flag the
   * figure as partial (the existing `CreatorDealCostPanel` does this).
   */
  partial: boolean;
};

// ─── GGR shape ───────────────────────────────────────────────────────

export type CreatorCodeUserGgr = {
  /** Canonical GGR for the cohort over the window = wager − gamingPayout. */
  ggr: number;
  /** Σ wager (pack/battle ledger + upgrader bet), borrow-corrected. */
  wager: number;
  /** Σ gaming payout (inventory pack/battle + battle_refund + battle_excess + upgrader won). */
  gamingPayout: number;
  /** Inventory pack/battle payout only (`value_at_obtained`). */
  inventoryPayout: number;
  /** Ledger gaming-payout legs only (`battle_refund` + `battle_excess_to_voucher`). */
  ledgerGamingPayout: number;
  /** Upgrader wager only (`upgrader_games.bet_amount`), already in `wager`. */
  upgraderWager: number;
  /** Upgrader payout only (`upgrader_games.won_amount`), already in `gamingPayout`. */
  upgraderPayout: number;
};

// ─── Net P&L shape (the surface consumes this) ───────────────────────

export type CreatorNetPnl = {
  /** Echo of the window this was computed for. */
  period: DashboardPeriod;
  /** netPnl = codeUserGgr.ggr − totalCost.total (commission-EXCLUSIVE). */
  netPnl: number;
  /** Same, but with referral commission folded into the cost side. */
  netPnlWithCommission: number;
  codeUserGgr: CreatorCodeUserGgr;
  totalCost: CreatorTotalCost;
};

// ─── Windowed code-user GGR (Term 1) ─────────────────────────────────

/**
 * The attribution-windowed code-user GGR for one creator over a window.
 *
 * Three parallel canonical reads, each with the creator-attribution
 * `EXISTS` predicate AND the canonical `getMetricsScope` (staff + blacklist
 * dropped, creator-on-session rows excluded — applied symmetrically on the
 * wager + payout sides via the session-window CTE):
 *
 *   1. ledger legs — Σ wager over WAGER_TYPES (borrow + reward-pack
 *      corrected via WAGER_LEG_FILTER) and Σ ledger gaming payout over
 *      GAMING_PAYOUT_TYPES (`battle_refund` + `battle_excess_to_voucher`),
 *      bucketed by `created_at`.
 *   2. inventory payout — Σ `value_at_obtained` for source pack/battle
 *      (borrow + reward-pack corrected via PAYOUT_LEG_FILTER), bucketed by
 *      `obtained_at` (symmetric attribution on `obtained_at`).
 *   3. upgrader — Σ `bet_amount` / `won_amount` from `upgrader_games`
 *      (real gameplay, NOT in the ledger), bucketed by `created_at`,
 *      attributed by the SAME coverage window. `to_regclass`-guarded →
 *      contributes 0 on a pre-upgrader DB (the current snapshot).
 *
 * `since: null` (lifetime `?period=all`) drops the lower bound. The
 * 7-day attribution window is independent of the report window — an event
 * inside the report window is attributed by ITS OWN timestamp's coverage,
 * exactly like the deposit model.
 *
 * The creator id is passed as a BIND PARAMETER ($1) — never concatenated.
 */
async function getCreatorCodeUserGgr(
  creatorUserId: string,
  since: Date | null,
): Promise<CreatorCodeUserGgr> {
  return withTiming("creators.netPnl.codeUserGgr", async () => {
    const db = await getDb();
    const scope = await getMetricsScope();

    // Inline `AND <col> >= '<iso>'::timestamptz`, or empty for lifetime.
    // `since` is a server-constructed Date (never user input); formatted to
    // ISO so no raw value is concatenated.
    const sinceClause = (col: string): string =>
      since === null ? "" : `AND ${col} >= '${since.toISOString()}'::timestamptz`;

    // The attribution predicate, keyed per leg on the event's user/ts
    // columns. Creator id is bind $1 in every query below.
    const attrLedger = creatorAttributionExists({
      userCol: "user_id",
      tsCol: "created_at",
    });
    const attrInventory = creatorAttributionExists({
      userCol: "user_id",
      tsCol: "obtained_at",
    });

    type LedgerRow = { wager: string; ledger_payout: string };
    type InvRow = { inv_payout: string };

    // Upgrader: probe once (pre-upgrader snapshot returns NULL, not an
    // error). Gated so the per-creator upgrader read degrades to 0 rather
    // than throwing 42P01 on a migration-lagged DB.
    const upgProbe = await db.$queryRaw<{ exists: string | null }[]>`
      SELECT to_regclass('public.upgrader_games')::text AS exists`;
    const hasUpgrader = upgProbe[0]?.exists != null;
    const upgBlacklist = blacklistNotInClause(
      "u_acu.id",
      await getExcludedUserIds(),
    );

    type UpgRow = { upg_wager: string; upg_payout: string };

    const [ledgerRows, invRows, upgRows] = await Promise.all([
      db.$queryRawUnsafe<LedgerRow[]>(
        `WITH ${scope.sessionWindowsCte}
         SELECT
           COALESCE(SUM(CASE WHEN type IN ${WAGER_TYPES_SQL} THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS wager,
           COALESCE(SUM(CASE WHEN type IN ${GAMING_PAYOUT_TYPES_SQL} THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS ledger_payout
         FROM ledger_transactions
         WHERE status = 'completed'
           AND user_id IN ${scope.userScopeSql}
           AND ${scope.notInCreatorSession("user_id", "created_at")}
           ${sinceClause("created_at")}
           -- Wager-side borrow + reward-pack exclusion (Fix 1 + Fix 2),
           -- the SAME shared predicate the canonical getGamingLegs uses;
           -- the GAMING_PAYOUT legs are summed unconditionally within
           -- their type filter above.
           AND ${WAGER_LEG_FILTER}
           -- Creator-cohort attribution: this user was on THIS creator's
           -- code (7-day coverage window) at the event time, most-recent
           -- covering code wins, creator's own play dropped.
           AND ${attrLedger}`,
        creatorUserId,
      ),
      db.$queryRawUnsafe<InvRow[]>(
        `WITH ${scope.sessionWindowsCte}
         SELECT
           COALESCE(SUM(value_at_obtained::numeric), 0)::text AS inv_payout
         FROM user_inventory
         WHERE source_type IN ('pack','battle')
           AND user_id IN ${scope.userScopeSql}
           AND ${scope.notInCreatorSession("user_id", "obtained_at")}
           ${sinceClause("obtained_at")}
           -- Payout-side borrow + reward-pack exclusion (Fix 2), same
           -- shared predicate as getGamingLegs.
           AND ${PAYOUT_LEG_FILTER}
           -- Attribution keyed on obtained_at (symmetric with the wager
           -- side's created_at), so a won card lands on the creator whose
           -- code covered the user when the card was obtained.
           AND ${attrInventory}`,
        creatorUserId,
      ),
      hasUpgrader
        ? db.$queryRawUnsafe<UpgRow[]>(
            // Upgrader has no acu wager row (it is NOT in the ledger), so
            // we attribute its plays directly by the coverage window on
            // (user_id, created_at). The canonical upgrader scope is the
            // wholesale-creator-drop real-customer set (matching the shared
            // `upgraderMetrics` reader) — staff + blacklist dropped. The
            // attribution EXISTS narrows that to this creator's cohort.
            `SELECT
               COALESCE(SUM(bet_amount::numeric), 0)::text AS upg_wager,
               COALESCE(SUM(won_amount::numeric), 0)::text AS upg_payout
             FROM upgrader_games ug
             WHERE ug.user_id IN (
                 SELECT u_acu.id FROM "user" u_acu
                  WHERE u_acu.role NOT IN ('admin', 'support', 'creator') ${upgBlacklist}
               )
               ${sinceClause("ug.created_at")}
               AND ${creatorAttributionExists({
                 userCol: "ug.user_id",
                 tsCol: "ug.created_at",
               })}`,
            creatorUserId,
          )
        : Promise.resolve([] as UpgRow[]),
    ]);

    const wagerLedger = toNumber(ledgerRows[0]?.wager);
    const ledgerGamingPayout = toNumber(ledgerRows[0]?.ledger_payout);
    const inventoryPayout = toNumber(invRows[0]?.inv_payout);
    const upgraderWager = toNumber(upgRows[0]?.upg_wager);
    const upgraderPayout = toNumber(upgRows[0]?.upg_payout);

    const wager = wagerLedger + upgraderWager;
    const gamingPayout = gamingPayoutTotal({
      inventoryPayout,
      // battleRefund field carries the ledger gaming-payout legs +
      // upgrader payout, exactly like getGamingLegs.
      battleRefund: ledgerGamingPayout + upgraderPayout,
    });

    return {
      ggr: ggrFormula({ wager, gamingPayout }),
      wager,
      gamingPayout,
      inventoryPayout,
      ledgerGamingPayout,
      upgraderWager,
      upgraderPayout,
    };
  });
}

// ─── Total creator cost (Term 2) ─────────────────────────────────────

/**
 * Unify the house's total spend ON this creator. Sources mostly already
 * exist; this just sums them and exposes commission distinctly.
 *
 *   totalCost = fillPayouts + netFill + leaderboardCost
 *   ( + commission, exposed separately — owner decides )
 *
 *   • fillPayouts + netFill — `getCreatorMultiplierCost` (the
 *     `creator_multiplier_payout` voucher + the net `creator_fill_*`
 *     lifecycle, which already absorbs the house-funded
 *     `creator_fill_spend_tip` / `creator_fill_spend_battle`).
 *   • leaderboardCost — `getCreatorLeaderboardCost`
 *     (Σ `(prize − refund) × house%` over APPROVED leaderboards).
 *   • commission — `affiliate_accounts.total_paid_out_usd` (lifetime).
 *
 * `creator_tip` is NOT subtracted — it is a verified pure user→user
 * pass-through ($0 net house cost; RESIDUAL in `ledger-sets.ts`).
 *
 * ── CLAIMED-vs-COMMITTED note (leaderboardCost) ──
 * `getCreatorLeaderboardCost` weights the COMMITTED prize pool
 * (`total_prize_usd` net of the creation/refund escrow) by the sponsored
 * %. The owner's preferred figure is the manually-CLAIMED prize total
 * (unclaimed `affiliate_leaderboard_prize` is never paid). The backend
 * leaderboard admin API this reuses exposes the committed pool, NOT a
 * per-board claimed total, so the committed calc is used and FLAGGED here.
 * If prod exposes a claimed-prize aggregate (e.g. a SUM of
 * `affiliate_leaderboard_prize` ledger rows scoped to a board), switch
 * `leaderboardCost` to that — the shape here does not change.
 *
 * ── BEST-EFFORT ──
 * The multiplier + leaderboard sub-fetches are backend round-trips; each
 * is caught independently so one failure degrades that bucket to 0 and
 * flips `partial = true` (the total becomes a lower bound) rather than
 * blanking the whole figure. Commission is a Main-DB read; on failure it
 * degrades to `null` (the creator has no commission attributed).
 */
export async function getCreatorTotalCost(
  creatorUserId: string,
): Promise<CreatorTotalCost> {
  return withTiming("creators.netPnl.totalCost", async () => {
    const db = await getDb();

    const [multiplier, leaderboard, commissionRow] = await Promise.all([
      getCreatorMultiplierCost(creatorUserId).catch((e) => {
        console.error(
          "[creator-net-pnl] multiplier cost fetch failed (bucket = 0, total is a lower bound):",
          e,
        );
        return null;
      }),
      getCreatorLeaderboardCost(creatorUserId).catch((e) => {
        console.error(
          "[creator-net-pnl] leaderboard cost fetch failed (bucket = 0, total is a lower bound):",
          e,
        );
        return null;
      }),
      // Commission = lifetime affiliate payout. Main-DB read on the
      // affiliate account; null when the user was never provisioned as an
      // affiliate (no row) or the read fails.
      db.affiliate_accounts
        .findUnique({
          where: { user_id: creatorUserId },
          select: { total_paid_out_usd: true },
        })
        .catch((e) => {
          console.error(
            "[creator-net-pnl] commission (affiliate_accounts.total_paid_out_usd) read failed (rendering null):",
            e,
          );
          return null;
        }),
    ]);

    const fillPayouts = multiplier?.payoutUsd ?? 0;
    const netFill = multiplier?.netFillUsd ?? 0;
    const leaderboardCost = leaderboard?.costUsd ?? 0;
    const commission =
      commissionRow == null ? null : toNumber(commissionRow.total_paid_out_usd);

    const total = fillPayouts + netFill + leaderboardCost;
    const totalWithCommission = total + (commission ?? 0);
    const partial = multiplier === null || leaderboard === null;

    return {
      total,
      totalWithCommission,
      breakdown: { fillPayouts, netFill, leaderboardCost, commission },
      partial,
    };
  });
}

// ─── Composed net P&L (the single-creator entry point) ───────────────

/**
 * One call → the full Net Creator P&L for one creator over the active
 * window: the attribution-windowed code-user GGR (Term 1) MINUS the
 * total creator cost (Term 2), with BOTH sides returned visibly so the
 * surface can render the decomposition.
 *
 * The cost side is lifetime (the cost sources are lifetime aggregates from
 * the backend / affiliate account); only the GGR side is window-scoped.
 * Surfaces should label the cost as lifetime so a windowed `netPnl` is
 * read correctly (a short window's GGR vs lifetime spend). A windowed cost
 * is a follow-up if/when the backend exposes per-window deal aggregates.
 *
 * Active-timeframe-only: pass the active `?period=`; nothing else is read.
 */
export async function getCreatorNetPnl(
  creatorUserId: string,
  period: DashboardPeriod,
): Promise<CreatorNetPnl> {
  const since = period === "all" ? null : periodToCutoff(period, new Date());

  const [codeUserGgr, totalCost] = await Promise.all([
    getCreatorCodeUserGgr(creatorUserId, since),
    getCreatorTotalCost(creatorUserId),
  ]);

  return {
    period,
    netPnl: codeUserGgr.ggr - totalCost.total,
    netPnlWithCommission: codeUserGgr.ggr - totalCost.totalWithCommission,
    codeUserGgr,
    totalCost,
  };
}
