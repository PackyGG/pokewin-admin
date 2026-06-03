import "server-only";

import { adminDb } from "@/lib/admin-db";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { invalidateMetricCaches } from "@/lib/account-wipes/invalidate-metric-caches";

/**
 * exclude.ts — a REUSABLE server-side helper to add a packy.gg user to the
 * admin-managed excluded-users blacklist (the same `excluded_users` admin-DB
 * store that `getExcludedUserIds` reads and `getMetricsScope` applies). Once a
 * user is on this list they are dropped from EVERY metric surface
 * (dashboard / GGR / analytics / insights / P&L) via the blacklist fragments.
 *
 * ─── WHY THIS EXISTS (separate from the /system/excluded-users action) ──────
 *
 * The existing `addExcludedUser` server action in
 * `src/app/(admin)/system/excluded-users/actions.ts` is gated behind
 * `requireExcludedUsersAccess()` — a MOTHA-ONLY allowlist. The account-wipe
 * flow runs under a DIFFERENT, broader gate (requireAdmin +
 * `__can_wipe_accounts` + 2FA), so it cannot reuse that motha-only action
 * without either widening that gate or duplicating its write inline. This
 * helper is the shared, gate-agnostic core: the CALLER is responsible for
 * authorizing the operation (the wipe action already did: requireAdmin +
 * capability + 2FA) and passes the authenticated admin id in. Both the
 * motha-only page action and this wipe-side helper write to the SAME table
 * via the SAME idempotency guard, so the store can never diverge.
 *
 * ─── SAFETY (owner mandate) ─────────────────────────────────────────────────
 *
 * Exclusion is NON-DESTRUCTIVE: it deletes NOTHING. It only inserts one row
 * into the admin-DB blacklist so the user is filtered OUT of metric
 * aggregates. Because it deletes no gameplay/finance data, it is SAFE to apply
 * even to creators/ex-creators (creator-protection guards against DELETING a
 * creator's data — an exclusion removes nothing). The wipe flow therefore adds
 * the user to the blacklist regardless of creator status.
 *
 *   • IDEMPOTENT: re-adding an already-excluded user is a no-op (no duplicate
 *     row — `user_id` is the PK; we guard on a findUnique first). `inserted`
 *     reflects whether a NEW row was actually written.
 *   • AUDITED: a new insert writes an `excluded_user_added` admin audit event
 *     (same event type the motha-only action uses), so the action shows up in
 *     the audit trail with who/when/why. A no-op (already excluded) writes no
 *     duplicate audit row.
 *   • CACHE-INVALIDATED: after a NEW insert we bust the metric caches via the
 *     shared `invalidateMetricCaches` (the same one the wipe uses) so the
 *     exclusion takes effect on the cached dashboard / GGR / analytics /
 *     insights surfaces immediately instead of lingering for a TTL.
 *
 * DUAL-DB (strict): the blacklist lives in the ADMIN DB (`adminDb`). This
 * helper only ever touches `adminDb.excluded_users` + the admin audit table —
 * never the main game DB. `getExcludedUserIds` (which reads this table) is the
 * sole bridge into the main-DB metric queries, exactly as today.
 */

/** Result of an exclusion attempt: `inserted` is 1 on a new row, 0 if already excluded. */
export type ExcludeUserResult = { inserted: 0 | 1 };

/**
 * Add `userId` to the excluded-users blacklist. The CALLER must have already
 * authorized the operation (the wipe action gates with requireAdmin +
 * `__can_wipe_accounts` + 2FA before calling this).
 *
 * @param userId   packy.gg user id to exclude (validated by the caller).
 * @param adminUserId the authenticated admin performing the exclusion (for the
 *                 `excluded_by` column + the audit row).
 * @param reason   optional human reason stored on the row + in the audit
 *                 metadata (e.g. "Auto-excluded on account wipe").
 *
 * Idempotent + audited + cache-invalidated on a NEW insert. A no-op (already
 * excluded) returns `{ inserted: 0 }` without a duplicate row, audit event, or
 * cache bust. Never throws on a duplicate; a genuine DB error propagates to the
 * caller (the wipe action surfaces it as a soft, non-fatal warning since the
 * destructive wipe itself has already committed).
 */
export async function excludeUserFromMetrics(params: {
  userId: string;
  adminUserId: string;
  reason?: string | null;
}): Promise<ExcludeUserResult> {
  const { userId, adminUserId } = params;
  const reason = params.reason ?? null;

  // Idempotency guard — `user_id` is the PK, so a second add would 500 on a
  // unique violation. Check first and short-circuit to a no-op, matching the
  // motha-only `addExcludedUser` action's behaviour exactly.
  const existing = await adminDb.excluded_users.findUnique({
    where: { user_id: userId },
    select: { user_id: true },
  });
  if (existing) {
    return { inserted: 0 };
  }

  await adminDb.excluded_users.create({
    data: {
      user_id: userId,
      reason,
      excluded_by: adminUserId,
    },
  });

  // Audit only the real insert (no duplicate audit on a no-op). Same event
  // type the /system/excluded-users page emits, so both paths read uniformly
  // in the audit log.
  await createAdminAuditEvent({
    adminUserId,
    eventType: "excluded_user_added",
    targetUserId: userId,
    metadata: { reason, source: "account_wipe" },
  });

  // Bust the metric caches so the exclusion takes effect across the cached
  // dashboard / GGR / analytics / insights surfaces immediately. Reuses the
  // same shared invalidator the wipe actions use (best-effort + non-throwing).
  invalidateMetricCaches(userId);

  return { inserted: 1 };
}
