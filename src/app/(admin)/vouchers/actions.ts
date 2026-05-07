"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";

const createVoucherSchema = z.object({
  userId: z.string().min(1, "User is required"),
  value: z
    .number()
    .finite()
    .positive("Value must be positive")
    .max(10_000_000),
  description: z.string().trim().max(500).optional(),
});

export async function searchUsers(query: string) {
  const db = await getDb();
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

export async function createVoucher(data: z.infer<typeof createVoucherSchema>) {
  const db = await getDb();
  const session = await requirePageAccess("/vouchers");
  await requireCapability(session, "__can_create_voucher", "create vouchers");

  const parsed = createVoucherSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid voucher input");
  }

  const user = await db.user.findUnique({ where: { id: parsed.data.userId } });
  if (!user) throw new Error("User not found");

  // NOTE: This uses raw SQL because the 'manual' origin is not in the
  // voucher_origin enum in prisma/schema.prisma. Either the DB enum has
  // been updated out-of-band or this flow was never exercised — either
  // way, switching to the typed Prisma client here currently produces a
  // TS2322 error. Leave as raw SQL until the schema drift is resolved.
  const [voucher] = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO vouchers (user_id, value, origin, description)
     VALUES ($1, $2, 'manual', $3)
     RETURNING id`,
    parsed.data.userId,
    parsed.data.value,
    parsed.data.description || null,
  );

  await adminDb.admin_voucher_actions.create({
    data: {
      voucher_id: voucher.id,
      action: "created",
      admin_user_id: session.userId,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "voucher_created",
    targetUserId: parsed.data.userId,
    metadata: { voucher_id: voucher.id, value: parsed.data.value },
  });

  revalidatePath("/vouchers");
}
