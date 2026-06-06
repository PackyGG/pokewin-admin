import "server-only";

// Reuse the EXISTING creator queries from the (admin) group. The
// (creator-hub) group is a sibling of (admin) on disk, so these relative
// paths cross the route-group boundary to the canonical query modules.
import { getCreatorsGlobalStats } from "../../../(admin)/creators/_queries/creators-stats";
import {
  getAllCreatorsNetGgr,
  type CreatorNetGgrRow,
} from "../../../(admin)/creators/_queries/all-creators-net-pnl";
import { type DashboardPeriod } from "@/lib/queries/dashboard-period";

/**
 * Creator Hub dashboard — overview data.
 *
 * Wires ONLY existing, verified query functions (no new heavy MAIN scans
 * under time pressure) and is HONEST about coverage:
 *
 *  REAL, windowed (driven by `getAllCreatorsNetGgr(period)` — a cached,
 *  attribution-windowed ledger pass over every creator's code cohort for
 *  the selected window):
 *    - `affiliateWagerUsd`  — Σ cohort wager over the window
 *      (`legs.wagersTotal`). This is genuine windowed affiliate wager.
 *    - `netGgrUsd`          — Σ cohort GGR over the window (house POV).
 *    - `topCreators`        — per-creator rows (username, image, windowed
 *                             wager + GGR + signups), ranked by wager.
 *
 *  REAL, lifetime/now (driven by `getCreatorsGlobalStats()` — the backend
 *  creator-roster walk):
 *    - `totalCreators`      — total creator accounts.
 *    - `liveCount`          — creators live right now (`active_session_id`).
 *
 *  NOT AVAILABLE as a true windowed query yet → returned as `null` so the
 *  UI renders a clearly-labeled placeholder (NEVER a fabricated number).
 *  These need new windowed MAIN queries, deferred:
 *    - `creatorCostUsd`     — 24h creator cost (payouts + leaderboard +
 *                             fill). Per-creator backend round-trips today.
 *    - `signups`            — windowed sign-ups from creator codes.
 *    - `ftds`               — windowed new first-time depositors.
 *    - `depositsUsd`        — windowed deposits from referred players.
 *
 * Active-timeframe-only: one window per call (the period the user selected).
 * Both underlying reads are independently cached/timeout-guarded; this just
 * runs them in parallel and shapes a serializable result for the page.
 */

/** A single ranked Top-Creator row for the dashboard list. */
export type HubTopCreator = {
  creatorUserId: string;
  username: string | null;
  image: string | null;
  /** Windowed affiliate wager booked against this creator's cohort. */
  wagerUsd: number;
  /** Windowed code-user GGR for this creator's cohort (house POV). */
  ggrUsd: number;
};

export type HubDashboardOverview = {
  period: DashboardPeriod;
  /** REAL — total creator accounts (backend roster). */
  totalCreators: number | null;
  /** REAL — creators live right now (backend `active_session_id`). */
  liveCount: number | null;
  /** REAL — Σ windowed cohort affiliate wager (house gain → emerald). */
  affiliateWagerUsd: number | null;
  /** REAL — Σ windowed cohort GGR (house POV). */
  netGgrUsd: number | null;
  /** PLACEHOLDER — no windowed cost query yet (deferred). */
  creatorCostUsd: number | null;
  /** PLACEHOLDER — no windowed signup query yet (deferred). */
  signups: number | null;
  /** PLACEHOLDER — no windowed FTD query yet (deferred). */
  ftds: number | null;
  /** PLACEHOLDER — no windowed deposits query yet (deferred). */
  depositsUsd: number | null;
  /** REAL — top creators ranked by windowed wager (already wager-desc). */
  topCreators: HubTopCreator[];
  /** True when the backend roster walk failed (totals show "—"). */
  rosterUnavailable: boolean;
};

/** How many ranked creators the dashboard's Top Creators list shows. */
const TOP_CREATORS_LIMIT = 6;

export async function getHubDashboardOverview(
  period: DashboardPeriod,
): Promise<HubDashboardOverview> {
  // Both reads are best-effort + independently degradable. The backend
  // roster walk (global stats) can be down while the Main-DB windowed GGR
  // still resolves, and vice versa, so a failure in one must not blank the
  // other. Net GGR is the heavier read; both are already cached internally.
  const [statsResult, netGgr] = await Promise.allSettled([
    getCreatorsGlobalStats(),
    getAllCreatorsNetGgr(period),
  ]);

  const stats =
    statsResult.status === "fulfilled" ? statsResult.value : null;
  const ggr = netGgr.status === "fulfilled" ? netGgr.value : null;
  if (statsResult.status === "rejected") {
    console.error(
      "[creator-hub] global stats failed (totals render '—'):",
      statsResult.reason,
    );
  }
  if (netGgr.status === "rejected") {
    console.error(
      "[creator-hub] windowed net GGR failed (wager/GGR/top render '—'):",
      netGgr.reason,
    );
  }

  const topCreators: HubTopCreator[] = (ggr?.byCreator ?? [])
    .slice(0, TOP_CREATORS_LIMIT)
    .map((r: CreatorNetGgrRow) => ({
      creatorUserId: r.creatorUserId,
      username: r.username,
      image: r.image,
      wagerUsd: r.wager,
      ggrUsd: r.ggr,
    }));

  return {
    period,
    totalCreators: stats ? stats.totalCreators : null,
    liveCount: stats ? stats.liveCount : null,
    affiliateWagerUsd: ggr ? ggr.legs.wagersTotal : null,
    netGgrUsd: ggr ? ggr.totalGgr : null,
    // Deferred — no true windowed query exists; surface as placeholders.
    creatorCostUsd: null,
    signups: null,
    ftds: null,
    depositsUsd: null,
    topCreators,
    rosterUnavailable: statsResult.status === "rejected",
  };
}
