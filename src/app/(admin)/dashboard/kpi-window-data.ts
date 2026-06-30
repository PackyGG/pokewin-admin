import "server-only";

import {
  getDashboardKpiStats,
  getGgrBreakdownForKpiWindow,
  type DashboardKpiWindow,
  type GgrBreakdown,
} from "@/lib/queries/dashboard";
import { compareDashboardCashflow } from "@/lib/clickhouse/comparison";
import { resolveAdminRead } from "@/lib/clickhouse/resolve-read";
import {
  getDashboardCashflowFromClickHouse,
  type DashboardCashflowCh,
} from "@/lib/clickhouse/queries/dashboard-cashflow";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";

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

  // ---- Period-bound box values ----
  /**
   * HEADLINE GGR — industry definition (`wager − payouts`, inventory-delta
   * sourced). "What we won from the games today (packs, battles, upgrader)" —
   * the gaming margin, pre-rewards, pre-promo. Positive → house up → emerald;
   * negative → house down → rose.
   */
  ggr: number;
  /**
   * SECONDARY: Cash P&L (`deposits − withdrawals`) for the window. Surfaced
   * INSIDE the GGR popover alongside the headline so an operator can audit
   * net cash kept (crypto-flow tracking) without leaving the tile. Not the
   * headline number.
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
  depositCount: number;
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
export async function buildKpiWindowPayload(
  window: DashboardKpiWindow,
): Promise<KpiWindowPayload> {
  const [stats, ggrBreakdown] = await Promise.all([
    getDashboardKpiStats(window),
    getGgrBreakdownForKpiWindow(window).catch(() => ({
      wagers: [],
      payouts: [],
      wagersTotal: 0,
      payoutsTotal: 0,
      ggr: 0,
    })),
  ]);

  // CQRS serve path for the `dashboard_cashflow` surface — a SUBSET cutover.
  // The shared `getDashboardKpiStats` aggregate above still runs (it produces
  // the GGR / wager / breakdown boxes, which have no CH twin at this leg), so
  // only the four cash-flow figures resolve through ClickHouse:
  //   • clickhouse → serve the CH cash-flow twin (SOLE read for these 4 fields;
  //     on failure THROWS so the page's render boundary degrades).
  //   • comparison → serve the Postgres slice, fire-and-forget drift log.
  //   • off        → serve the Postgres slice (today's behavior).
  const cashflow = await resolveAdminRead<DashboardCashflowCh>(
    "dashboard_cashflow",
    {
      pg: async () => ({
        deposits: stats.deposits,
        depositCount: stats.depositCountPeriod,
        withdrawals: stats.withdrawals,
        withdrawalCount: stats.withdrawalCountPeriod,
      }),
      ch: async () => {
        const blacklist = await getExcludedUserIds();
        return getDashboardCashflowFromClickHouse(window, blacklist);
      },
      compare: (pg) => {
        void compareDashboardCashflow(window, pg);
      },
    },
  );

  // Owner reverted the GGR definition (2026-06-30 follow-up): the HEADLINE
  // GGR tile reads the industry definition again (`wager − payouts`, what
  // we won from the games today — packs, battles, upgrader). Cash P&L
  // (`deposits − withdrawals`) is kept as a SECONDARY figure inside the
  // popover so an operator can still see net cash kept (crypto-flow
  // tracking) without leaving the tile, but it is no longer the headline.
  const cashGgr = cashflow.deposits - cashflow.withdrawals;

  return {
    window,
    windowLabel: stats.periodLabel,
    ggr: stats.ggr,
    cashGgr,
    wager: stats.wagers,
    wagerBreakdown: stats.wagersBreakdown,
    wagerOrganic: stats.wagersOrganic,
    deposits: cashflow.deposits,
    depositCount: cashflow.depositCount,
    withdrawals: cashflow.withdrawals,
    withdrawalCount: cashflow.withdrawalCount,
    ggrBreakdown,
  };
}
