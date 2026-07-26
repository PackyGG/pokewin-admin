import { unstable_cache } from "next/cache";
import { withTiming } from "@/lib/observability/query-timings";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { calculateWindowedPnl, type WindowedPnl } from "./pnl";

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
 * Cached inner computation. Keyed on the UTC day string + the serialized
 * blacklist so it re-fills when the day rolls over OR when an admin edits
 * the excluded-users list. `revalidate: 60` matches the dashboard's
 * activity-cache cadence (cheap, slow-moving window).
 *
 * Pattern note: the blacklist is resolved OUTSIDE `unstable_cache` and
 * passed in as a serializable arg (same as `cachedDailyChart` &c. in
 * dashboard.ts) — `getExcludedUserIds()` reads the admin DB and can't run
 * inside the cache scope. `calculateWindowedPnl` resolves the MAIN client,
 * which resolves to the prod client inside the cache scope (cookies are
 * unavailable there, so `readDbEnv` falls back to prod) — identical to the
 * established dashboard cache wrappers.
 */
const cachedTodayPnl = unstable_cache(
  async (
    dayKey: string,
    sinceIso: string,
    excludeUserIds: string[],
  ): Promise<WindowedPnl> => {
    void dayKey; // part of the cache key only
    // through the cache on failure); off/comparison serve Postgres. Parity
    // confirmed cent-exact (aligned-window harness; live-tail CDC-lag only).
    return calculateWindowedPnl({
      since: new Date(sinceIso),
      excludeUserIds,
    });
  },
  ["dashboard-today-pnl-v2"],
  { revalidate: 60, tags: ["dashboard-activity"] },
);

export async function getTodayPnl(): Promise<TodayPnl> {
  return withTiming("pnl.today", async () => {
    const now = new Date();
    const since = utcStartOfDay(now);
    const sinceIso = since.toISOString();
    // YYYY-MM-DD in UTC — stable cache key for "today" that rolls at
    // 00:00 UTC.
    const dayKey = sinceIso.slice(0, 10);
    const excluded = await getExcludedUserIds();

    const pnl = await cachedTodayPnl(dayKey, sinceIso, excluded);
    return { ...pnl, dayStartIso: sinceIso };
  });
}
