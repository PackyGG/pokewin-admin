"use server";

import { revalidatePath } from "next/cache";
import { adminDb } from "@/lib/admin-db";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { require2FA } from "@/lib/require-2fa";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { ALL_PAGE_KEYS } from "@/lib/admin-pages";

export async function forceExpireAllSessions(adminUserId: string) {
  const session = await requireAdmin();
  await requireCapability(session, "__can_force_expire_admin_sessions", "force-expire admin sessions");

  await adminDb.admin_sessions.updateMany({
    where: {
      admin_user_id: adminUserId,
      logged_out_at: null,
      expires_at: { gt: new Date() },
    },
    data: { logged_out_at: new Date() },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_sessions_force_expired",
    metadata: { target_admin_id: adminUserId },
  });

  revalidatePath(`/admin-users/${adminUserId}`);
}

export async function updateUserPermissions(
  userId: string,
  pages: string[],
  totpCode: string,
) {
  const session = await requireAdmin();
  await requireCapability(session, "__can_update_admin_permissions", "update admin permissions");
  await require2FA(session.userId, totpCode);

  const targetUser = await adminDb.admin_users.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (!targetUser || targetUser.role === "admin") {
    throw new Error("Cannot set permissions for admin users");
  }

  const validPages = pages.filter((p) => ALL_PAGE_KEYS.includes(p));

  await adminDb.admin_users.update({
    where: { id: userId },
    data: { allowed_pages: validPages },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_permissions_updated",
    metadata: { target_admin_id: userId, pages: validPages },
  });

  revalidatePath(`/admin-users/${userId}`);
  revalidatePath("/", "layout");
}

export async function searchMainSiteUsers(query: string) {
  const db = await getDb();
  await requireAdmin();

  if (!query || query.length < 2) return [];

  const users = await db.user.findMany({
    where: {
      OR: [
        { username: { contains: query, mode: "insensitive" } },
        { email: { contains: query, mode: "insensitive" } },
      ],
    },
    select: { id: true, username: true, email: true, role: true },
    take: 10,
  });

  return users.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
  }));
}

export async function linkCreatorToMainUser(adminUserId: string, mainUserId: string) {
  const db = await getDb();
  const session = await requireAdmin();

  const adminUser = await adminDb.admin_users.findUnique({
    where: { id: adminUserId },
    select: { role: true, email: true },
  });
  if (!adminUser || adminUser.role !== "creator") {
    throw new Error("Admin user is not a creator");
  }

  const mainUser = await db.user.findUnique({
    where: { id: mainUserId },
    select: { id: true, email: true, username: true, role: true },
  });
  if (!mainUser) throw new Error("Main site user not found");
  if (!mainUser.email) throw new Error("Main site user has no email");

  // Update admin_user email to match main site user (this is how linking works)
  await adminDb.admin_users.update({
    where: { id: adminUserId },
    data: { email: mainUser.email },
    select: { id: true },
  });

  // If the main user isn't already a creator, set them up
  if (mainUser.role !== "creator") {
    const code = (mainUser.username ?? mainUser.email.split("@")[0])
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");

    let finalCode = code;
    const existingCode = await db.affiliate_codes.findUnique({ where: { code: finalCode } });
    if (existingCode) {
      finalCode = `${code}${Math.floor(Math.random() * 1000)}`;
    }

    await db.$transaction([
      db.user.update({
        where: { id: mainUserId },
        data: { role: "creator", affiliate_code: finalCode, affiliate_code_active: true },
      }),
      db.affiliate_accounts.create({
        data: { user_id: mainUserId },
      }),
      db.affiliate_codes.create({
        data: { user_id: mainUserId, code: finalCode },
      }),
    ]);
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "creator_linked_to_main_user",
    metadata: {
      target_admin_id: adminUserId,
      main_user_id: mainUserId,
      main_user_email: mainUser.email,
    },
  });

  revalidatePath(`/admin-users/${adminUserId}`);
}
