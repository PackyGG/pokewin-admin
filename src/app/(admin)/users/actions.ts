"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requirePageAccess, requireAdmin } from "@/lib/dal";
import { require2FA } from "@/lib/require-2fa";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { resolveAdminMainUserId } from "@/lib/resolve-admin-main-user-id";

export async function banUser(userId: string, reason: string) {
  const db = await getDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_ban_users", "ban users");

  // `user.banned_by` is a nullable FK to Main-DB `User.id`. Admin
  // identities live in the Admin DB so we resolve via email match;
  // unlinked admins fall back to null and the audit event below
  // remains the source of truth for who actually triggered the ban.
  const issuerMainUserId = await resolveAdminMainUserId(session.userId);

  await db.$transaction([
    db.user.update({
      where: { id: userId },
      data: {
        is_banned: true,
        banned_reason: reason,
        banned_at: new Date(),
        banned_by: issuerMainUserId,
      },
    }),
    db.session.deleteMany({ where: { userId } }),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "account_banned",
    targetUserId: userId,
    metadata: { reason, issuer_main_user_id: issuerMainUserId },
  });

  revalidatePath("/users");
  revalidatePath(`/users/${userId}`);
  revalidatePath("/chat");
}

export async function unbanUser(userId: string) {
  const db = await getDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_ban_users", "unban users");

  await db.$transaction([
    db.user.update({
      where: { id: userId },
      data: {
        is_banned: false,
        banned_reason: null,
        banned_at: null,
        banned_by: null,
      },
    }),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "account_unbanned",
    targetUserId: userId,
  });

  revalidatePath("/users");
  revalidatePath(`/users/${userId}`);
}

export async function lockUser(userId: string, reason: string) {
  const db = await getDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_lock_users", "lock user accounts");

  // `user.locked_by` is a nullable FK to Main-DB `User.id`. Same
  // resolution as `banUser` — admin → main user via email; null when
  // no match. Audit event is the canonical trail.
  const issuerMainUserId = await resolveAdminMainUserId(session.userId);

  await db.$transaction([
    db.user.update({
      where: { id: userId },
      data: {
        is_locked: true,
        locked_reason: reason,
        locked_at: new Date(),
        locked_by: issuerMainUserId,
      },
    }),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "account_locked",
    targetUserId: userId,
    metadata: { reason, issuer_main_user_id: issuerMainUserId },
  });

  revalidatePath("/users");
  revalidatePath(`/users/${userId}`);
}

export async function unlockUser(userId: string) {
  const db = await getDb();
  const session = await requirePageAccess("/users");
  await requireCapability(session, "__can_lock_users", "unlock user accounts");

  await db.$transaction([
    db.user.update({
      where: { id: userId },
      data: {
        is_locked: false,
        locked_reason: null,
        locked_at: null,
        locked_by: null,
        locked_until: null,
      },
    }),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "account_unlocked",
    targetUserId: userId,
  });

  revalidatePath("/users");
  revalidatePath(`/users/${userId}`);
}

export async function deleteUser(userId: string, totpCode: string) {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_delete_user", "delete users");
  await require2FA(session.userId, totpCode);

  // Fetch username for audit log before deleting
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { username: true, email: true },
  });
  if (!user) throw new Error("User not found");

  const label = user.username ?? user.email ?? userId;

  // Audit BEFORE the destructive delete so a failed/aborted attempt is still
  // captured. If the audit insert itself fails, abort — never delete without
  // a paper trail.
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_deleted",
    targetUserId: userId,
    metadata: { deleted_user_id: userId, username: label },
  });

  await db.user.delete({ where: { id: userId } });

  revalidatePath("/users");
}

export async function bulkDeleteUsers(userIds: string[], totpCode: string) {
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_bulk_delete_users", "bulk-delete users");
  await require2FA(session.userId, totpCode);

  if (userIds.length === 0) throw new Error("No users selected");
  if (userIds.length > 100) throw new Error("Max 100 users at once");

  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, username: true, email: true },
  });

  const labels = new Map(
    users.map((u) => [u.id, u.username ?? u.email ?? u.id]),
  );

  // Audit BEFORE the destructive delete so a failed bulk-delete is still
  // captured. The metadata snapshot is taken pre-delete from `users` above.
  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "users_bulk_deleted",
    metadata: {
      count: userIds.length,
      users: userIds.map((id) => ({ id, username: labels.get(id) ?? id })),
    },
  });

  await db.user.deleteMany({ where: { id: { in: userIds } } });

  revalidatePath("/users");
}
