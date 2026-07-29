import "server-only";

import { cache } from "react";

import {
  getDashboardKpiStats,
  getGgrBreakdownForKpiWindow,
  type DashboardKpiWindow,
  type GgrBreakdown,
} from "@/lib/queries/dashboard";
import { getDashboardCashflowFromPostgres } from "@/lib/queries/dashboard-cashflow-pg";
import { getDepositFundedGgrForWindow } from "@/lib/queries/dashboard-deposit-funded-ggr";
import { readDbEnv } from "@/lib/db-env";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  buildCacheKey,
  cacheGetOrSetStale,
  hashString,
} from "@/lib/cache/redis";
import {
  REWARD_QUERY_TIMEOUT_MS,
  safeQuery,
  withTimeout,
} from "@/lib/errors/safe-query";

/**
 * Serializable snapshot of every dashboard KPI box for ONE window
 * ("today" or "24h"). Built from the shared `getDashboardKpiStats`
 * aggregate (+ the GGR breakdown legs) and handed to the client KPI
 * section so the per-box today/24h toggle can switch between two
 * server-computed windows WITHOUT any function props crossing the RSC
 * boundary (CLAUDE.md / Next 15) — it's all plain numbers / strings.
 *
 * The PERIOD-BOUND boxes (GGR, Wager, Organic Wager, Deposits,
 * Withdrawals) change with the window and carry their per-window value
 * here. The SNAPSHOT boxes (Total Users, FTDs 24h, Depositors, Avg
 * Deposit, Deposits/Hour, Avg RTP) are lifetime / fixed-window figures
 * that do NOT vary by the today/24h selection, so they are NOT part of
 * this per-window payload — the server renders them once from the eager
 * "today" stats and they don't re-fetch on toggle (an honest UI: no toggle
 * on a box whose number can't change).
 */
export type KpiWindowPayload = {
  /** Which window this payload was computed for. */
  window: DashboardKpiWindow;
  /** Friendly label for the window (e.g. "Today" / "Last 24h"). */
  windowLabel: string;
  /** When the underlying snapshot was successfully computed. */
  capturedAtIso: string;
  /** When this request served it; a gap means last-known-good data is shown. */
  servedAtIso: string;
  /** Per-box truthfulness flags for cold-start failures without retained data. */
  wagerAvailable: boolean;
  cashflowAvailable: boolean;
  ggrAvailable: boolean;

  // ---- Period-bound box values ----
  /**
   * HEADLINE GGR — DASHBOARD-LOCAL "deposit-funded" definition (owner
   * request, 2026-07-02; see `dashboard-deposit-funded-ggr.ts` for the full
   * algorithm). Per real customer, chronologically traces how much of their
   * window wagering was fundable by money THEY deposited IN THIS SAME
   * WINDOW (FIFO pool, never replenished by wins), then apportions their
   * payout to that funded share proportionally. Summed across users. This
   * intentionally EXCLUDES wagering funded by balance carried over from a
   * prior window, so headline GGR can no longer exceed what a "just this
   * window's money" reading would expect. Every OTHER GGR consumer
   * reads the industry definition (`wager − payouts`) via `getWindowMetrics`
   * — that figure is preserved in `ggrBreakdown` below as a reference.
   * Positive → house up → emerald; negative → house down → rose.
   */
  ggr: number;
  /**
   * SECONDARY: Cash P&L (`deposits − withdrawals`) for the window. Surfaced
   * INSIDE the GGR popover alongside the headline so an operator can audit
   * net cash kept (fiat + crypto cash-flow tracking) without leaving the
   * tile. Not the headline number.
   */
  cashGgr: number;
  /** Customer wager (creator-on-stream sessions excluded) for the window. */
  wager: number;
  /** Packs / Battles / Upgrader split of `wager` (sums to it). */
  wagerBreakdown: { packs: number; battles: number; upgrader: number };
  /** Organic wager — users who did NOT join under a creator code. */
  wagerOrganic: number;
  /** Total deposit dollars + transaction count for the window. */
  deposits: number;
  /** Gross completed deposits before fiat refunds processed in the window. */
  grossDeposits: number;
  depositCount: number;
  /** Fiat credit reversed by full/partial refunds processed in the window. */
  fiatRefunds: number;
  fiatRefundCount: number;
  /** Total withdrawal dollars + completed/shipped request count. */
  withdrawals: number;
  withdrawalCount: number;
  // ---- GGR breakdown legs (for the GGR box's Info popover) ----
  /** Industry-GGR breakdown legs — secondary reference inside the popover. */
  ggrBreakdown: GgrBreakdown;
};

/**
 * Build the per-window KPI payload for the client section. Runs the shared
 * `getDashboardKpiStats` aggregate (React-cached per request + day/60s
 * cached for the heavy legs) and the GGR breakdown legs in parallel.
 *
 * Empty-but-valid GGR breakdown when its legs fail/degrade so the GGR box
 * still renders its headline number (matches the page's existing
 * fallback shape for the chip-enum path).
 */
async function computeKpiWindowPayload(
  window: DashboardKpiWindow,
): Promise<KpiWindowPayload> {
  const [statsResult, ggrBreakdown, depositFundedGgr] = await Promise.all([
    safeQuery(
      () => getDashboardKpiStats(window),
      null,
      "dashboard.kpiStats",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    getGgrBreakdownForKpiWindow(window).catch(() => ({
      wagers: [],
      payouts: [],
      wagersTotal: 0,
      payoutsTotal: 0,
      ggr: 0,
    })),
    // Dashboard-local headline override (owner request, 2026-07-02) — see
    // dashboard-deposit-funded-ggr.ts. Falls back to the industry figure
    // (stats.ggr, via ggrBreakdown once resolved below) if this read fails,
    // so the tile never goes blank on a transient error.
    getDepositFundedGgrForWindow(window).catch(() => null),
  ]);
  const stats = statsResult.data;

  const cashflowResult = await safeQuery(
    () => getDashboardCashflowFromPostgres(window),
    null,
    "dashboard.cashflow",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const cashflow = cashflowResult.data;

  // The shared aggregate above produces the GGR and wager boxes. Cash-flow
  // figures use their dedicated PostgreSQL read so they stay aligned with the
  // canonical P&L-today definition.
  //
  // RECONCILIATION FIX (2026-07-02): the PG slice is NO LONGER the shared
  // aggregate's `stats.deposits/withdrawals` (which scopes to the CUSTOMER
  // population — CREATORS DROPPED — because that same query builds the
  // customer-wager legs). That made the box read LOWER than the "P&L Today"
  // tile, which uses the `calculateWindowedPnl` cash-flow definition (creators
  // KEPT + manual admin-adjustment withdrawals). Both are labelled "today
  // deposits / withdrawals", so they must agree. The dedicated
  // `getDashboardCashflowFromPostgres` reproduces the P&L-Today cash-flow
  // definition EXACTLY (creators kept, card + |manual| withdrawals), so the
  // box and P&L Today reconcile by construction — without touching the frozen
  // `calculateWindowedPnl` math or the creator-excluded wager / period-P&L
  // boxes.
  // Owner reverted the GGR definition (2026-06-30 follow-up): the HEADLINE
  // GGR tile reads the industry definition again (`wager − payouts`, what
  // we won from the games today — packs, battles, upgrader). Cash P&L
  // (`deposits − withdrawals`) is kept as a SECONDARY figure inside the
  // popover so an operator can still see net cash kept (fiat + crypto cash-flow
  // tracking) without leaving the tile, but it is no longer the headline.
  const cashGgr = cashflow
    ? cashflow.deposits - cashflow.withdrawals
    : 0;
  const capturedAtIso = new Date().toISOString();

  return {
    window,
    windowLabel: stats?.periodLabel ?? (window === "today" ? "Today" : "Last 24h"),
    capturedAtIso,
    servedAtIso: capturedAtIso,
    wagerAvailable: stats !== null,
    cashflowAvailable: cashflow !== null,
    ggrAvailable: depositFundedGgr !== null || stats !== null,
    ggr: depositFundedGgr ?? stats?.ggr ?? 0,
    cashGgr,
    wager: stats?.wagers ?? 0,
    wagerBreakdown: stats?.wagersBreakdown ?? {
      packs: 0,
      battles: 0,
      upgrader: 0,
    },
    wagerOrganic: stats?.wagersOrganic ?? 0,
    deposits: cashflow?.deposits ?? 0,
    grossDeposits: cashflow?.grossDeposits ?? 0,
    depositCount: cashflow?.depositCount ?? 0,
    fiatRefunds: cashflow?.fiatRefunds ?? 0,
    fiatRefundCount: cashflow?.fiatRefundCount ?? 0,
    withdrawals: cashflow?.withdrawals ?? 0,
    withdrawalCount: cashflow?.withdrawalCount ?? 0,
    ggrBreakdown,
  };
}

export function emptyKpiWindowPayload(
  window: DashboardKpiWindow,
): KpiWindowPayload {
  const nowIso = new Date().toISOString();
  return {
    window,
    windowLabel: window === "today" ? "Today" : "Last 24h",
    capturedAtIso: nowIso,
    servedAtIso: nowIso,
    wagerAvailable: false,
    cashflowAvailable: false,
    ggrAvailable: false,
    ggr: 0,
    cashGgr: 0,
    wager: 0,
    wagerBreakdown: { packs: 0, battles: 0, upgrader: 0 },
    wagerOrganic: 0,
    deposits: 0,
    grossDeposits: 0,
    depositCount: 0,
    fiatRefunds: 0,
    fiatRefundCount: 0,
    withdrawals: 0,
    withdrawalCount: 0,
    ggrBreakdown: {
      wagers: [],
      payouts: [],
      wagersTotal: 0,
      payoutsTotal: 0,
      ggr: 0,
    },
  };
}

async function buildResilientKpiWindowPayload(
  window: DashboardKpiWindow,
): Promise<KpiWindowPayload> {
  let partial: KpiWindowPayload | null = null;
  try {
    const [env, excluded] = await Promise.all([
      readDbEnv(),
      getExcludedUserIds(),
    ]);
    if (env !== "prod") {
      return computeKpiWindowPayload(window);
    }

    const scopeKey = hashString([...excluded].sort().join(","));
    const key = buildCacheKey("dashboard-kpi-v3", [env, window, scopeKey]);
    const payload = await cacheGetOrSetStale(
      key,
      60,
      24 * 60 * 60,
      async () => {
        partial = await withTimeout(
          () => computeKpiWindowPayload(window),
          10_000,
        );
        // A partial cold result remains useful when no snapshot exists, but it
        // must never replace a complete last-known-good snapshot.
        if (
          !partial.wagerAvailable ||
          !partial.cashflowAvailable
        ) {
          throw new Error("dashboard KPI core metrics were incomplete");
        }
        return partial;
      },
    );
    return { ...payload, servedAtIso: new Date().toISOString() };
  } catch {
    return partial ?? emptyKpiWindowPayload(window);
  }
}

/**
 * Request-local dedupe for the shared "today" payload. The dashboard renders
 * it in both the KPI strip and the P&L tile; without React cache both
 * Suspense branches independently assemble the same payload on a cold render.
 * Cross-request freshness remains governed by the underlying tagged caches.
 */
export const buildKpiWindowPayload = cache(buildResilientKpiWindowPayload);
