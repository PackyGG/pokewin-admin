"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { eq, ilike, or, sql } from "drizzle-orm";

import { adminDrizzle, getDrizzleDb } from "@/lib/drizzle";
import { admin_voucher_actions } from "@/lib/db-schema/admin/schema";
import { user } from "@/lib/db-schema/main/schema";
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
  const db = await getDrizzleDb();
  await requirePageAccess("/vouchers");

  if (!query || query.length < 2) return [];

  const users = await db
    .select({ id: user.id, username: user.username, email: user.email })
    .from(user)
    .where(
      or(
        ilike(user.username, `%${query}%`),
        ilike(user.email, `%${query}%`),
        eq(user.id, query),
      ),
    )
    .limit(10);

  return users.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email,
  }));
}

export async function createVoucher(data: z.infer<typeof createVoucherSchema>) {
  const db = await getDrizzleDb();
  const session = await requirePageAccess("/vouchers");
  await requireCapability(session, "__can_create_voucher", "create vouchers");

  const parsed = createVoucherSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid voucher input");
  }

  const [targetUser] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, parsed.data.userId))
    .limit(1);
  if (!targetUser) throw new Error("User not found");

  // NOTE: This uses raw SQL because the 'manual' origin is not in the
  // voucher_origin enum in the MAIN Drizzle schema. Either the DB enum has
  // been updated out-of-band or this flow was never exercised — either
  // way, using the generated enum column type here is invalid. Keep this as
  // parameterized raw SQL until the schema drift is resolved.
  const voucherResult = await db.execute<{ id: string }>(sql`
    INSERT INTO vouchers (user_id, value, origin, description)
    VALUES (
      ${parsed.data.userId},
      ${String(parsed.data.value)},
      'manual',
      ${parsed.data.description || null}
    )
    RETURNING id
  `);
  const voucher = voucherResult.rows[0];
  if (!voucher) throw new Error("Voucher creation failed");

  await adminDrizzle.insert(admin_voucher_actions).values({
      voucher_id: voucher.id,
      action: "created",
      admin_user_id: session.userId,
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "voucher_created",
    targetUserId: parsed.data.userId,
    metadata: { voucher_id: voucher.id, value: parsed.data.value },
  });

  revalidatePath("/vouchers");
}
