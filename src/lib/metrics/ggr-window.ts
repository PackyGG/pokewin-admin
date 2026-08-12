import { MS_PER_DAY } from "@/lib/utils/time";
import {
  type DashboardPeriod,
  periodToCutoff,
} from "@/lib/queries/dashboard-period";
import { type MetricWindow } from "@/lib/metrics/queries";

/**
 * Client-safe GGR window helpers. This module imports no server-only database
 * code—only client-safe period helpers, `MS_PER_DAY`, and the `MetricWindow`
 * type (erased at compile time).
 */

// ─── Window helper ───────────────────────────────────────────────────

/**
 * Capped lifetime lookback (days) for the `/ggr` "all" (Lifetime) window.
 *
 * `/ggr` exposes a Lifetime chip, but a TRUE unbounded window (`since:
 * null`) makes EVERY aggregate the breakdown runs — the gaming wager /
 * payout legs, the reward leg, the neutral + reward per-type sweep, the
 * per-category split, and the per-user contributor join — scan the entire
 * ~400k-row `ledger_transactions` history (plus the full `user_inventory`
 * and `upgrader_games`) with no lower bound, which blows the 30s statement
 * timeout and collapses the whole report to its error boundary
 * ("Couldn't load GGR"). So Lifetime is bounded to the same capped lookback
 * the rest of the codebase uses for lifetime scans —
 * `LIFETIME_PAIRING_LOOKBACK_DAYS = 365` (deposit-bonus `_shared.ts`, also
 * mirrored inline by rakeback ROI / signup daily / `suspicious.ts`). The
 * value is duplicated here as a local constant (rather than imported across
 * the unrelated deposit-bonus surface) to keep this module decoupled, the
 * SAME way `suspicious.ts` / `signup/daily.ts` inline `365` with a
 * reference comment. Keep this in sync with that canonical 365-day guard.
 */
export const GGR_LIFETIME_LOOKBACK_DAYS = 365;

/**
 * Convert a `/ggr` window chip to the canonical `MetricWindow` the
 * `@/lib/metrics` builders take. The rolling 24h / 3d / 7d windows map to
 * their `periodToCutoff` cutoff. The `all` (Lifetime) window does NOT map
 * to an unbounded `{ since: null }` — that triggers a full-history scan
 * across every aggregate the breakdown runs and times out (see
 * {@link GGR_LIFETIME_LOOKBACK_DAYS}); instead it maps to a BOUNDED cutoff
 * `now − 365 days`. Because every reader in this module derives its window
 * filter from this single `since` (via the metric layer's `sinceClause` and
 * the local `sinceFrag` builders), capping here bounds the ENTIRE report —
 * headline, legs, per-type sweep, per-category split, and contributors — in
 * one place. Kept as a single helper so the page, the export, and the
 * contributor query agree on the window.
 */
export function ggrWindowToMetricWindow(
  window: DashboardPeriod,
  now: Date = new Date(),
): MetricWindow {
  if (window !== "all") {
    return { since: periodToCutoff(window, now) };
  }
  // Lifetime → bounded 365-day lookback (NOT unbounded) so no aggregate
  // runs a full-history scan. Mirrors the canonical capped-lifetime guard.
  const since = new Date(
    now.getTime() - GGR_LIFETIME_LOOKBACK_DAYS * MS_PER_DAY,
  );
  return { since };
}
