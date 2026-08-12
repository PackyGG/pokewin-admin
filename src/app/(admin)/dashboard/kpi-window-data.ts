import "server-only";

import { cache } from "react";

import {
  getDashboardKpiStats,
  getGgrBreakdownForKpiWindow,
  type DashboardKpiWindow,
  type GgrBreakdown,
} from "@/lib/queries/dashboard";
import { getDashboardCashflowFromPostgres } from "@/lib/queries/dashboard-cashflow-pg";
import { readDbEnv } from "@/lib/db-env";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import {
  buildCacheKey,
  cacheGetOrSetStale,
  hashString,
} from "@/lib/cache/redis";
import { safeQuery, withTimeout } from "@/lib/errors/safe-query";

/**
 * Per-leg budget for the KPI payload, deliberately SMALLER than
 * {@link KPI_PAYLOAD_TIMEOUT_MS}. Each leg must be able to time out and fall
 * back on its own while the surrounding compute still returns — a leg that
 * outlives the payload budget takes the whole snapshot down with it (see the
 * invariant on `buildResilientKpiWindowPayload`).
 */
const KPI_LEG_TIMEOUT_MS = 11_000;

/**
 * Outer budget for assembling one window's payload. Must stay under the
 * `REWARD_QUERY_TIMEOUT_MS` wrapper the dashboard page puts around
 * {@link buildKpiWindowPayload}, or the page kills the assembly before the
 * snapshot can be written.
 *
 * Both budgets are sized off a measured cold `getDashboardKpiStats("today")` of
 * ~8s on the production mirror. A tighter leg budget meant the aggregate never
 * completed, so a complete snapshot was never stored and every reader — cold or
 * not — fell through to the empty payload.
 */
const KPI_PAYLOAD_TIMEOUT_MS = 13_000;

/**
 * Empty-but-valid GGR breakdown, returned FRESH each call so the degraded
 * payload and the empty payload never share the same arrays.
 */
function emptyGgrBreakdown(): GgrBreakdown {
  return {
    wagers: [],
    payouts: [],
    wagersTotal: 0,
    payoutsTotal: 0,
    ggr: 0,
  };
}

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
  /** Canonical industry GGR: wagers − gaming payouts for the window. */
  ggr: number;
  /**
   * SECONDARY: net cash flow (`deposits − withdrawals`) for the window. Surfaced
   * INSIDE the GGR popover alongside the headline so an operator can audit
   * net cash kept (fiat + crypto cash-flow tracking) without leaving the
   * tile. Not the headline number.
   */
  netCashFlow: number;
  /** Customer wager (creator-on-stream sessions excluded) for the window. */
  wager: number;
  /** Per-game split of `wager` (sums to it exactly). */
  wagerBreakdown: {
    packs: number;
    battles: number;
    keno: number;
    upgrader: number;
    doubleDown: number;
  };
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
  // All three legs run in PARALLEL and each owns its own timeout. They used to
  // run in sequence, which meant a slow cash-flow read burned the payload's
  // whole budget AFTER the wager read had already succeeded — and because the
  // outer budget then expired, that successful wager result was thrown away
  // too. The mirror pool's admission limiter bounds the actual DB concurrency,
  // so issuing them together costs nothing and keeps one slow leg off the
  // others' clock.
  const [statsResult, cashflowResult, ggrBreakdownResult] = await Promise.all([
    safeQuery(
      () => getDashboardKpiStats(window),
      null,
      "dashboard.kpiStats",
      KPI_LEG_TIMEOUT_MS,
    ),
    safeQuery(
      () => getDashboardCashflowFromPostgres(window),
      null,
      "dashboard.cashflow",
      KPI_LEG_TIMEOUT_MS,
    ),
    // Same leg budget as the other two. A bare `.catch` covers a REJECTION but
    // not a hang: without a timeout this leg could outlive
    // KPI_PAYLOAD_TIMEOUT_MS, and when the outer backstop wins `partial` is
    // never assigned — so a slow breakdown blanked the ENTIRE strip even
    // though the stats and cash-flow legs had already succeeded. That is
    // exactly the invariant documented on `buildResilientKpiWindowPayload`.
    safeQuery(
      () => getGgrBreakdownForKpiWindow(window),
      emptyGgrBreakdown(),
      "dashboard.ggrBreakdown",
      KPI_LEG_TIMEOUT_MS,
    ),
  ]);
  const stats = statsResult.data;
  const cashflow = cashflowResult.data;
  const ggrBreakdown = ggrBreakdownResult.data;

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
  // The headline GGR reads the canonical industry definition (`wager −
  // payouts`, what we won from games today — packs, battles, upgrader).
  // Net cash flow (`deposits − withdrawals`) is a SECONDARY figure inside the
  // popover so an operator can still see net cash kept (fiat + crypto cash-flow
  // tracking) without leaving the tile, but it is no longer the headline.
  const netCashFlow = cashflow
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
    ggrAvailable: stats !== null,
    ggr: stats?.ggr ?? 0,
    netCashFlow,
    wager: stats?.wagers ?? 0,
    wagerBreakdown: stats?.wagersBreakdown ?? {
      packs: 0,
      battles: 0,
      keno: 0,
      upgrader: 0,
      doubleDown: 0,
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
    netCashFlow: 0,
    wager: 0,
    wagerBreakdown: {
      packs: 0,
      battles: 0,
      keno: 0,
      upgrader: 0,
      doubleDown: 0,
    },
    wagerOrganic: 0,
    deposits: 0,
    grossDeposits: 0,
    depositCount: 0,
    fiatRefunds: 0,
    fiatRefundCount: 0,
    withdrawals: 0,
    withdrawalCount: 0,
    ggrBreakdown: emptyGgrBreakdown(),
  };
}

/**
 * INVARIANT: `computeKpiWindowPayload` must always settle INSIDE
 * {@link KPI_PAYLOAD_TIMEOUT_MS} (its legs are individually capped at
 * {@link KPI_LEG_TIMEOUT_MS} and run in parallel). The outer race below is a
 * backstop only — when it wins, `partial` was never assigned, so every box in
 * the strip degrades at once even though most legs may have succeeded. Keep the
 * leg budget strictly below the payload budget or a single slow read blanks the
 * whole KPI strip and the P&L tile's GGR section again.
 */
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
    const key = buildCacheKey("dashboard-kpi-v5-organic-all-games", [
      env,
      window,
      scopeKey,
    ]);
    const payload = await cacheGetOrSetStale(
      key,
      60,
      24 * 60 * 60,
      async () => {
        partial = await withTimeout(
          () => computeKpiWindowPayload(window),
          KPI_PAYLOAD_TIMEOUT_MS,
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
