"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";

export async function banUser(userId: string, reason: string) {
  const session = await requirePageAccess("/users");

  await db.$transaction([
    db.user.update({
      where: { id: userId },
      data: {
        is_banned: true,
        banned_reason: reason,
        banned_at: new Date(),
        banned_by: null,
      },
    }),
    db.session.deleteMany({ where: { userId } }),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "account_banned",
    targetUserId: userId,
    metadata: { reason },
  });

  revalidatePath("/users");
  revalidatePath(`/users/${userId}`);
  revalidatePath("/chat");
}

export async function unbanUser(userId: string) {
  const session = await requirePageAccess("/users");

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
  const session = await requirePageAccess("/users");

  await db.$transaction([
    db.user.update({
      where: { id: userId },
      data: {
        is_locked: true,
        locked_reason: reason,
        locked_at: new Date(),
        locked_by: null,
      },
    }),
  ]);

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "account_locked",
    targetUserId: userId,
    metadata: { reason },
  });

  revalidatePath("/users");
  revalidatePath(`/users/${userId}`);
}

export async function unlockUser(userId: string) {
  const session = await requirePageAccess("/users");

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
