"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";

import { adminDb } from "@/lib/admin-db";
import { verifySession } from "@/lib/dal";
import { isMainOwner } from "@/lib/owners";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { WITHDRAWALS_LIST_TAG } from "@/lib/queries/withdrawals";
import { ok, fail, type ServerActionResult } from "@/lib/errors/server-action-result";

/**
 * Withdrawal unlock / re-lock actions — MOTHA-ONLY.
 *
 * Excluded users are withdrawal-LOCKED by default (see
 * src/lib/withdrawal-lock/lock.ts). These actions grant / revoke the per-user
 * unlock override in the admin DB (`admin_withdrawal_unlocks`). Per the owner
 * rule (2026-07-01) ONLY motha — the permanent ROOT owner — may do this, so
 * the gate is `isMainOwner` (username === "motha"), NOT the broader owner tier
 * that other owner-gated surfaces use. A non-motha caller (even a full owner)
 * is rejected server-side, independent of any UI visibility.
 *
 * Both return ServerActionResult so the client branches on `result.success`
 * instead of a redacted 500 (matches the withdrawals process/cancel actions).
 */

// packy.gg user_ids are 32-char-ish alphanumeric better-auth nanoids. Validate
// strictly so a paste of a URL / garbage never reaches the table.
const USER_ID_REGEX = /^[A-Za-z0-9_-]+$/;
const userIdSchema = z
  .string()
  .trim()
  .min(8, "User ID looks too short")
  .max(64, "User ID looks too long")
  .regex(USER_ID_REGEX, "User ID contains invalid characters");

const unlockSchema = z.object({
  userId: userIdSchema,
  notes: z
    .string()
    .trim()
    .max(500, "Notes are too long")
    .nullish()
    .transform((v) => (v && v.length > 0 ? v : null)),
});

function revalidateWithdrawalSurfaces(): void {
  // The lock state gates the withdrawal ACTIONS and is surfaced on the list +
  // detail views. Evict the cached list (tag) and revalidate the relevant
  // routes so the locked/unlocked indication updates immediately.
  revalidateTag(WITHDRAWALS_LIST_TAG);
  revalidatePath("/withdrawals");
  revalidatePath("/transactions/deposits");
  revalidatePath("/system/excluded-users");
}

/**
 * Grant a per-user withdrawal UNLOCK override (motha-only). Idempotent upsert
 * on target_user_id, so re-granting refreshes the provenance without erroring.
 */
export async function unlockUserWithdrawals(input: {
  userId: string;
  notes?: string | null;
}): Promise<ServerActionResult<{ userId: string }>> {
  const session = await verifySession();
  if (!isMainOwner(session)) {
    return fail("Only motha can unlock withdrawals.", "FORBIDDEN");
  }

  const parsed = unlockSchema.safeParse(input);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid input", "INVALID_INPUT");
  }
  const { userId, notes } = parsed.data;

  await adminDb.admin_withdrawal_unlocks.upsert({
    where: { target_user_id: userId },
    create: {
      target_user_id: userId,
      unlocked_by: session.userId,
      notes,
    },
    update: {
      unlocked_by: session.userId,
      unlocked_at: new Date(),
      notes,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "withdrawal_unlocked",
    targetUserId: userId,
    metadata: { notes },
  });

  revalidateWithdrawalSurfaces();
  return ok({ userId });
}

/**
 * Revoke a user's withdrawal unlock override (motha-only) — re-locking them
 * while they remain on the blacklist. `deleteMany` so a stale double-click
 * after another tab already removed the row is a no-op, not a P2025 throw.
 */
export async function relockUserWithdrawals(
  userId: string,
): Promise<ServerActionResult<{ userId: string; deleted: number }>> {
  const session = await verifySession();
  if (!isMainOwner(session)) {
    return fail("Only motha can lock/unlock withdrawals.", "FORBIDDEN");
  }

  const parsed = userIdSchema.safeParse(userId);
  if (!parsed.success) {
    return fail(parsed.error.issues[0]?.message ?? "Invalid user ID", "INVALID_INPUT");
  }

  const result = await adminDb.admin_withdrawal_unlocks.deleteMany({
    where: { target_user_id: parsed.data },
  });

  if (result.count > 0) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "withdrawal_relocked",
      targetUserId: parsed.data,
    });
  }

  revalidateWithdrawalSurfaces();
  return ok({ userId: parsed.data, deleted: result.count });
}
