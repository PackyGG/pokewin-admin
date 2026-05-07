"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { adminDb } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { admin_role } from "@/generated/admin-prisma/client";
import { require2FA } from "@/lib/require-2fa";

export async function createAdminUser(data: {
  email: string;
  username: string;
  password: string;
  role: string;
}) {
  const session = await requireAdmin();
  await requireCapability(session, "__can_create_admin_user", "create admin users");

  const passwordHash = await bcrypt.hash(data.password, 12);

  // Inherit allowed_pages from existing users of the same role (the "role preset").
  // If no users exist yet for this role, defaults to empty (admin can configure
  // via /settings/roles after creation) — except for pack_creator, where the
  // role's whole purpose is fixed and the chicken-and-egg of "no preset users
  // exist yet" would otherwise leave a freshly-hired employee with zero access.
  let allowedPages: string[] = [];
  if (data.role !== "admin") {
    const existingUser = await adminDb.admin_users.findFirst({
      where: { role: data.role as admin_role },
      select: { allowed_pages: true },
    });
    if (existingUser) {
      allowedPages = existingUser.allowed_pages;
    } else if (data.role === "pack_creator") {
      // Out-of-the-box pack-creator can hit /packs, create new packs
      // (cover image upload included), AND edit packs that are still
      // in their inactive "demo" state — so they can iterate on a
      // pack after pressing Save without losing access to it.
      // Live (active=true) packs are off-limits to pack_creator —
      // that gate is enforced inside the updatePack action so even a
      // toggled-on capability flag won't let them touch a live pack.
      // They never get __can_toggle_pack_active, so they can't make
      // a pack live themselves. Admin can adjust this role's
      // permissions in /settings/roles → Pack Creator afterward.
      allowedPages = [
        "/packs",
        "__can_create_pack",
        "__can_update_pack",
        "__can_upload_pack_image",
      ];
    }
  }

  // Explicit select — Prisma's default create() RETURNS * which references
  // every column the generated client knows about. If a new column is
  // missing from prod (preferences / role_id / profile_*), the insert
  // crashes with P2022 even though the write itself would succeed.
  await adminDb.admin_users.create({
    data: {
      email: data.email,
      username: data.username,
      password_hash: passwordHash,
      role: data.role as admin_role,
      allowed_pages: allowedPages,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_user_created",
    metadata: { email: data.email, username: data.username, role: data.role },
  });

  revalidatePath("/admin-users");
}

export async function toggleAdminActive(
  adminUserId: string,
  isActive: boolean,
  totpCode: string,
) {
  const session = await requireAdmin();
  await requireCapability(session, "__can_toggle_admin_active", "activate / deactivate admins");

  // Self-protection: deactivating yourself locks you out instantly. Mirror
  // the check already in `deleteAdminUser` so the same accident can't be
  // made on the toggle path.
  if (adminUserId === session.userId && !isActive) {
    throw new Error("You cannot deactivate yourself");
  }

  await require2FA(session.userId, totpCode);

  await adminDb.admin_users.update({
    where: { id: adminUserId },
    data: { is_active: isActive },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: isActive ? "admin_user_activated" : "admin_user_deactivated",
    metadata: { target_admin_id: adminUserId },
  });

  revalidatePath("/admin-users");
}

export async function resetAdmin2FA(adminUserId: string, totpCode: string) {
  const session = await requireAdmin();
  await requireCapability(session, "__can_reset_admin_2fa", "reset admin 2FA");
  await require2FA(session.userId, totpCode);

  await adminDb.admin_users.update({
    where: { id: adminUserId },
    data: {
      totp_secret: null,
      totp_enabled: false,
      recovery_codes: [],
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_2fa_reset",
    metadata: { target_admin_id: adminUserId },
  });

  revalidatePath("/admin-users");
}

export async function changeAdminRole(adminUserId: string, newRole: string, totpCode: string) {
  const session = await requireAdmin();
  await requireCapability(session, "__can_change_admin_role", "change admin roles");

  await require2FA(session.userId, totpCode);

  if (!["admin", "support", "marketing", "creator"].includes(newRole)) {
    throw new Error("Invalid admin role");
  }

  await adminDb.admin_users.update({
    where: { id: adminUserId },
    data: { role: newRole as admin_role },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_role_changed",
    metadata: { target_admin_id: adminUserId, new_role: newRole },
  });

  revalidatePath("/admin-users");
}

export async function deleteAdminUser(
  adminUserId: string,
  totpCode: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const session = await requireAdmin();
  await requireCapability(session, "__can_delete_admin_user", "delete admin users");

  // Can't delete yourself
  if (adminUserId === session.userId) {
    return { success: false, error: "You cannot delete your own account" };
  }

  // 2FA gate AFTER the self-deletion guard so the user-facing "you cannot
  // delete yourself" error doesn't depend on TOTP being valid first.
  // require2FA throws on invalid; the caller surfaces it via toast.
  await require2FA(session.userId, totpCode);

  const target = await adminDb.admin_users.findUnique({
    where: { id: adminUserId },
    select: { id: true, email: true, username: true },
  });
  if (!target) return { success: false, error: "Admin user not found" };

  // Audit BEFORE the delete so the event is always on record
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_user_deleted",
    metadata: { target_admin_id: adminUserId, email: target.email, username: target.username },
  });

  try {
    await adminDb.$transaction(async (tx) => {
      // Null out admin_user_id on audit events (keep the logs)
      await tx.admin_audit_events.updateMany({
        where: { admin_user_id: adminUserId },
        data: { admin_user_id: null },
      });

      // Delete all related records with required FKs
      await tx.admin_sessions.deleteMany({ where: { admin_user_id: adminUserId } });
      await tx.admin_notes.deleteMany({ where: { admin_user_id: adminUserId } });
      await tx.admin_gift_card_actions.deleteMany({ where: { admin_user_id: adminUserId } });
      await tx.admin_voucher_actions.deleteMany({ where: { admin_user_id: adminUserId } });
      await tx.expenses.deleteMany({ where: { created_by_id: adminUserId } });
      await tx.recurring_expenses.deleteMany({ where: { created_by_id: adminUserId } });

      // Delete the admin user
      await tx.admin_users.delete({ where: { id: adminUserId } });
    });
  } catch (err) {
    console.error("[deleteAdminUser] Transaction failed:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return { success: false, error: `Delete failed: ${message}` };
  }

  revalidatePath("/admin-users");
  return { success: true };
}
