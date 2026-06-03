import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";
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

export type TodayPnl = WindowedPnl & {
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
 * inside the cache scope. `calculateWindowedPnl` itself calls `getDb()`,
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
    return calculateWindowedPnl({
      since: new Date(sinceIso),
      excludeUserIds,
    });
  },
  ["dashboard-today-pnl-v1"],
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

// ─── Inventory-Δ drill-down: where the held inventory value comes from ──

/**
 * One row of the "where the inventory value comes from" breakdown shown
 * by the lazy expander on the Inventory line of the P&L-Today popover.
 *
 * The `inventoryValue` is the user's CURRENTLY-HELD inventory snapshot —
 * the same figure that feeds the `inventoryValue` liability term of
 * `calculateUserPnl` (and the lifetime P&L `inventory` term in
 * _realized-pnl.ts): the sum of `user_inventory.value_at_obtained` for
 * rows that are neither sold nor exchanged and not locked for an
 * in-flight withdrawal.
 */
export type InventoryHolderRow = {
  userId: string;
  username: string | null;
  /** Currently-held inventory value (Σ value_at_obtained, held filter). */
  inventoryValue: number;
};

/**
 * Cached inner sweep — top-N current inventory holders. Keyed on the
 * resolved limit + the serialized blacklist (so it re-fills when an
 * admin edits the excluded-users list). `revalidate: 60` matches the
 * P&L-Today cache cadence; the snapshot moves slowly and a minute of
 * staleness is invisible to an operator.
 *
 * The blacklist is resolved OUTSIDE the cache scope and passed in as a
 * serializable arg (same pattern as `cachedTodayPnl` above and the
 * dashboard cache wrappers) — `getExcludedUserIds()` reads the admin DB
 * and can't run inside `unstable_cache`.
 *
 * The held-inventory filter + the `real_users` scope are COPIED VERBATIM
 * from `realizedPnlSnapshotInner` (_realized-pnl.ts) — the canonical
 * lifetime-P&L `inventory` term — so the sum of these per-user rows
 * reconciles with that snapshot by construction:
 *   • held filter: sold_at IS NULL AND exchanged_at IS NULL AND
 *     withdrawal_locked_at IS NULL, valued by value_at_obtained.
 *   • scope: role NOT IN ('admin','support') + the blacklist. Creators
 *     are KEPT — they're real users whose holdings are a real house
 *     liability, consistent with the P&L liability terms everywhere
 *     (_exclude-staff.ts).
 * Ordered by held value DESC, capped at `safeLimit` (≤ 50). Only rows
 * with a positive held value are returned so the list stays clean.
 */
const cachedInventoryTopHolders = unstable_cache(
  async (
    safeLimit: number,
    excludeUserIds: string[],
  ): Promise<InventoryHolderRow[]> => {
    const db = await getDb();
    const blacklistFrag = blacklistNotInClause("id", excludeUserIds);
    type QueryRow = {
      user_id: string;
      username: string | null;
      inventory_value: string;
    };
    const rows = await db.$queryRawUnsafe<QueryRow[]>(
      `WITH real_users AS (
         SELECT id, username
         FROM "user"
         WHERE role NOT IN ('admin', 'support') ${blacklistFrag}
       )
       SELECT
         ru.id::text AS user_id,
         ru.username,
         SUM(ui.value_at_obtained::numeric)::text AS inventory_value
       FROM user_inventory ui
       JOIN real_users ru ON ru.id = ui.user_id
       WHERE ui.sold_at IS NULL
         AND ui.exchanged_at IS NULL
         AND ui.withdrawal_locked_at IS NULL
       GROUP BY ru.id, ru.username
       HAVING SUM(ui.value_at_obtained::numeric) > 0
       ORDER BY SUM(ui.value_at_obtained::numeric) DESC
       LIMIT ${safeLimit}`,
    );
    return rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      inventoryValue: toNumber(r.inventory_value),
    }));
  },
  ["dashboard-inventory-top-holders-v1"],
  { revalidate: 60, tags: ["dashboard-activity"] },
);

/**
 * Top-N users by CURRENTLY-HELD inventory value — backs the lazy
 * "show more" expander on the Inventory line of the P&L-Today popover,
 * mirroring the GGR card's "top contributors" drill-down.
 *
 * NOT loaded with the tile — fired only when the admin opens the
 * expander (via the today-pnl server action), so the per-user GROUP BY
 * over `user_inventory` never runs on the initial dashboard render
 * (active-timeframe / lazy-load rule). `limit` is clamped to [1, 50].
 */
export async function getInventoryTopHolders(
  limit = 10,
): Promise<InventoryHolderRow[]> {
  return withTiming("pnl.today.inventoryHolders", async () => {
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 50));
    const excluded = await getExcludedUserIds();
    return cachedInventoryTopHolders(safeLimit, excluded);
  });
}
