"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { adminDb } from "@/lib/admin-db";
import { requireAdmin } from "@/lib/dal";
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

  const passwordHash = await bcrypt.hash(data.password, 12);

  await adminDb.admin_users.create({
    data: {
      email: data.email,
      username: data.username,
      password_hash: passwordHash,
      role: data.role as admin_role,
      ...(data.role === "creator" && { allowed_pages: ["/my-profile"] }),
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_user_created",
    metadata: { email: data.email, username: data.username, role: data.role },
  });

  revalidatePath("/admin-users");
}

export async function toggleAdminActive(adminUserId: string, isActive: boolean) {
  const session = await requireAdmin();

  await adminDb.admin_users.update({
    where: { id: adminUserId },
    data: { is_active: isActive },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: isActive ? "admin_user_activated" : "admin_user_deactivated",
    metadata: { target_admin_id: adminUserId },
  });

  revalidatePath("/admin-users");
}

export async function resetAdmin2FA(adminUserId: string) {
  const session = await requireAdmin();

  await adminDb.admin_users.update({
    where: { id: adminUserId },
    data: {
      totp_secret: null,
      totp_enabled: false,
      recovery_codes: [],
    },
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

  await require2FA(session.userId, totpCode);

  if (!["admin", "support", "marketing", "creator"].includes(newRole)) {
    throw new Error("Invalid admin role");
  }

  await adminDb.admin_users.update({
    where: { id: adminUserId },
    data: { role: newRole as admin_role },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "admin_role_changed",
    metadata: { target_admin_id: adminUserId, new_role: newRole },
  });

  revalidatePath("/admin-users");
}
