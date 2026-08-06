import { withTiming } from "@/lib/observability/query-timings";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { calculateWindowedPnlOneShot, type WindowedPnl } from "./pnl";

/**
 * Today's house P&L — the CURRENT CALENDAR DAY since 00:00 (NOT a rolling
 * past-24h window).
 *
 * Window: [today 00:00 UTC, now). The day boundary is UTC midnight, which
 * is exactly the convention the rest of the dashboard already uses for
 * "today" (see `users.today` in src/lib/queries/dashboard.ts, which
 * computes `startOfDay = new Date(now); startOfDay.setUTCHours(0,0,0,0)`,
 * and the UTC-anchored boundaries in _realized-pnl.ts / balance-limits.ts).
 * Anchoring to UTC keeps the figure identical no matter which region the
 * serverless function runs in.
 *
 * The arithmetic REUSES the canonical windowed-delta formula in
 * `calculateWindowedPnl` (the single source of truth shared by the
 * dashboard's period-P&L card and the daily-P&L chart):
 *
 *   pnl = Δdeposits − Δwithdrawals − Δbalance − Δinventory − Δvouchers
 *
 * over the window — so this "today" box reconciles with the existing P&L
 * surfaces by construction (it's the same formula, just with
 * since = today-00:00 instead of now − 24h). Global scope across real
 * users only (admin/support + the excluded-users blacklist dropped),
 * matching every other dashboard aggregate.
 */

type TodayPnl = WindowedPnl & {
  /** ISO timestamp of the window start (today 00:00 UTC) — drives the
   *  date header on the card so it reads e.g. "2026-06-03". */
  dayStartIso: string;
};

/**
 * UTC start-of-day for the instant `now`. Mirrors the dashboard's own
 * "today" boundary so this box agrees with the Total Users "+N today"
 * figure and the daily-P&L chart's most-recent bar.
 */
function utcStartOfDay(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * UNCACHED — deliberately (owner request, 2026-08-07: the tile must always
 * show the live figure). There is no `unstable_cache` wrapper and no
 * revalidate window, so every dashboard render reads the current state of the
 * day; the page's own 60s `AutoRefresh` poll is what paces it.
 *
 * The affordability of that comes from `calculateWindowedPnlOneShot`: the
 * same canonical five-term math as the cached period surfaces, but as ONE
 * statement over ONE pool slot (~100ms for a today-sized window) instead of
 * five parallel round-trips. That matters because the MAIN read pool is tiny
 * — an uncached five-query tile would cost five slots per concurrent viewer.
 *
 * The blacklist is resolved here rather than inside the query: it lives in the
 * ADMIN DB and is `cache()`-deduped per request.
 */
export async function getTodayPnl(): Promise<TodayPnl> {
  return withTiming("pnl.today", async () => {
    const now = new Date();
    const since = utcStartOfDay(now);
    const sinceIso = since.toISOString();
    const excluded = await getExcludedUserIds();

    const pnl: WindowedPnl = await calculateWindowedPnlOneShot({
      since,
      excludeUserIds: excluded,
    });
    // calculateWindowedPnl owns the shared refund-aware net-deposit contract.
    // Do not subtract again here; this wrapper only adds the day boundary.
    return {
      ...pnl,
      dayStartIso: sinceIso,
    };
  });
}
