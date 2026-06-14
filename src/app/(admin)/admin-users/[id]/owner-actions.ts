"use server";

import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/admin-db";
import { requireMainOwner, MAIN_OWNER_USERNAME } from "@/lib/owners";
import { require2FA } from "@/lib/require-2fa";
import { createAdminAuditEvent } from "@/lib/admin-audit";

/**
 * Grant or revoke OWNER / ultra-admin status on another admin.
 *
 * SECURITY — this is the most privileged toggle in the app (an owner bypasses
 * every page + capability check AND every owner-only surface), so it is gated
 * the tightest way possible:
 *   • `requireMainOwner()` — ONLY the main owner (motha) can manage owners.
 *     Other owners get full access but cannot grow/shrink the owner set.
 *   • `require2FA` — the actor must present a valid TOTP code (same as the
 *     other escalation-class admin actions: toggle-active, reset-2FA).
 *   • Audit — every change is recorded via `createAdminAuditEvent`.
 *
 * The permanent ROOT owner `motha` can NEVER be toggled here (motha is owner
 * via a code hard-coded bypass, not this column) — attempting to set motha's
 * flag is rejected. Writes only `admin_users.is_owner` (ADMIN DB).
 */
export async function setAdminOwner(
  adminUserId: string,
  isOwner: boolean,
  totpCode: string,
): Promise<void> {
  const session = await requireMainOwner();
  await require2FA(session.userId, totpCode);

  const target = await adminDb.admin_users.findUnique({
    where: { id: adminUserId },
    select: { id: true, username: true, is_active: true, is_owner: true },
  });
  if (!target) {
    throw new Error("Admin user not found");
  }

  // The permanent root owner (motha) is owner via the code bypass and can never
  // be un-ownered (or redundantly re-ownered) through this column.
  if ((target.username ?? "").trim().toLowerCase() === MAIN_OWNER_USERNAME) {
    throw new Error("The main owner is permanent and cannot be changed.");
  }

  // No-op writes would only add audit noise — skip if already in the desired
  // state so the log reflects real transitions.
  if (target.is_owner === isOwner) {
    return;
  }

  await adminDb.admin_users.update({
    where: { id: adminUserId },
    data: { is_owner: isOwner },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: isOwner ? "admin_owner_set" : "admin_owner_unset",
    metadata: {
      target_admin_id: adminUserId,
      target_username: target.username,
      is_owner: isOwner,
    },
  });

  // Owner status changes what this user can reach (the page/capability bypass +
  // the owner-only nav items), so bust the detail page + the whole layout tree.
  revalidatePath(`/admin-users/${adminUserId}`);
  revalidatePath("/admin-users");
  revalidatePath("/", "layout");
}
