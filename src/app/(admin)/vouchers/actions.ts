"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";

export async function searchUsers(query: string) {
  await requirePageAccess("/vouchers");

  if (!query || query.length < 2) return [];

  const users = await db.user.findMany({
    where: {
      OR: [
        { username: { contains: query, mode: "insensitive" } },
        { email: { contains: query, mode: "insensitive" } },
        { id: query },
      ],
    },
    select: { id: true, username: true, email: true },
    take: 10,
  });

  return users.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email,
  }));
}

export async function createVoucher(data: {
  userId: string;
  value: number;
  description?: string;
}) {
  const session = await requirePageAccess("/vouchers");

  const user = await db.user.findUnique({ where: { id: data.userId } });
  if (!user) throw new Error("User not found");

  const voucher = await db.vouchers.create({
    data: {
      user_id: data.userId,
      value: data.value,
      origin: "manual",
      description: data.description || null,
    },
  });

  await adminDb.admin_voucher_actions.create({
    data: {
      voucher_id: voucher.id,
      action: "created",
      admin_user_id: session.userId,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "voucher_created",
    targetUserId: data.userId,
    metadata: { voucher_id: voucher.id, value: data.value },
  });

  revalidatePath("/vouchers");
}
