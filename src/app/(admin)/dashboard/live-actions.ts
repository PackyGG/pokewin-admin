"use server";

import { requirePageAccess, verifySession } from "@/lib/dal";
import {
  getLiveDeposits,
  getLiveDepositsAndWithdrawals,
  getMoneyMovementsWatermark,
  getMoneyMovementTotals24h,
  type LiveDepositsResult,
  type LiveMoneyMovementsResult,
} from "@/lib/queries/dashboard-live";

/**
 * Poll endpoint for the live deposits panel on /dashboard.
 *
 * Cursor semantics:
 *   - `sinceCreatedAt == null` → initial fetch (returns up to `limit` newest).
 *   - Otherwise → strict-gt filter; returns only rows created AFTER the cursor.
 *
 * The 24h total is returned on every call so the hero number stays fresh
 * without a second round-trip.
 */
export async function fetchRecentDepositsLive(
  sinceCreatedAt: string | null,
): Promise<LiveDepositsResult> {
  await requirePageAccess("/dashboard");
  return getLiveDeposits({ sinceCreatedAt, limit: 30 });
}

/**
 * Poll endpoint for the combined deposits + withdrawals live feed.
 * Used by the docked `<LiveMoneyChat />` widget in the admin shell.
 * Same cursor contract as the deposits feed — the cursor is a single
 * timestamp that filters BOTH sources via strict-gt so each row is
 * delivered exactly once.
 *
 * Auth gate is `verifySession` (any logged-in admin) instead of
 * `requirePageAccess("/dashboard")` — the LiveMoneyChat widget mounts
 * in the admin shell layout on every admin page, so a support /
 * marketing / creator user without `/dashboard` in their `allowed_pages`
 * was getting a silent redirect on every 6s poll tick. Mirrors the same
 * fix already applied to `docked-recent-activity-actions.ts`.
 *
 * Optional `sinceWatermark` is the cursor the client has already seen
 * for the row feed. When provided, the server first runs the cheap
 * watermark pre-check (two indexed `findFirst` lookups, no joins) —
 * if nothing newer exists, it returns `{ unchanged: true, items: [], ... }`
 * with cached totals only, skipping the heavy 2-findMany + bonus-pairing
 * query batch entirely. On an idle feed that drops each poll tick from
 * ~5 queries to ~2 indexed lookups + a 60s-cached totals hit.
 */
export async function fetchRecentMoneyMovements(
  sinceCreatedAt: string | null,
  sinceWatermark?: string | null,
): Promise<LiveMoneyMovementsResult> {
  await verifySession();

  // Watermark short-circuit. Only engages on polls AFTER bootstrap
  // (`sinceWatermark != null`). The bootstrap path always runs the
  // heavy query to fill the panel; subsequent ticks check the
  // watermark first and bail with `unchanged: true` when nothing has
  // landed since.
  if (sinceWatermark !== undefined && sinceWatermark !== null) {
    const watermark = await getMoneyMovementsWatermark(sinceWatermark);
    if (watermark === null) {
      const totals = await getMoneyMovementTotals24h();
      return {
        items: [],
        total24hDeposits: totals.total24hDeposits,
        total24hWithdrawals: totals.total24hWithdrawals,
        unchanged: true,
      };
    }
  }

  return getLiveDepositsAndWithdrawals({ sinceCreatedAt, limit: 30 });
}
