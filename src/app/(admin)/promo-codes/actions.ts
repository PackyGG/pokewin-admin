"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createHash } from "crypto";
import { createAdminAuditEvent } from "@/lib/admin-audit";

const createPromoCodeSchema = z.object({
  code: z.string().trim().min(1, "Code is required").max(64, "Code is too long"),
  value: z
    .number()
    .finite()
    .nonnegative("Value cannot be negative")
    .max(10_000_000),
  region: z.enum(["NA", "EU"]),
  minimumLevel: z.number().int().nonnegative().max(1_000),
  minimumWagerAmount: z.number().finite().nonnegative().max(10_000_000),
  wagerPeriodDays: z.number().int().nonnegative().max(3650),
  minimumAccountAgeDays: z.number().int().nonnegative().max(3650),
  requiresDiscord: z.boolean(),
  maxUses: z.number().int().nonnegative().max(10_000_000),
  expiresAt: z.string().nullable(),
});

export async function createPromoCode(
  data: z.infer<typeof createPromoCodeSchema>,
) {
  const db = await getDb();
  const session = await requirePageAccess("/promo-codes");
  await requireCapability(session, "__can_create_promo_code", "create promo codes");

  const parsed = createPromoCodeSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid promo code input");
  }
  const v = parsed.data;

  const codeHash = createHash("sha256").update(v.code.toUpperCase()).digest("hex");

  const existing = await db.promo_codes.findFirst({
    where: { code_hash: codeHash },
  });
  if (existing) throw new Error("A promo code with this value already exists");

  await db.promo_codes.create({
    data: {
      id: crypto.randomUUID(),
      code_hash: codeHash,
      value: v.value,
      region: v.region,
      minimum_level: v.minimumLevel,
      minimum_wager_amount: v.minimumWagerAmount,
      wager_period_days: v.wagerPeriodDays,
      minimum_account_age_days: v.minimumAccountAgeDays,
      requires_discord: v.requiresDiscord,
      max_uses: v.maxUses,
      expires_at: v.expiresAt ? new Date(v.expiresAt) : null,
      metadata: { code: v.code },
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "promo_code_created",
    metadata: { code_hash: codeHash, value: v.value, region: v.region },
  });

  revalidatePath("/promo-codes");
}

export async function getRedemptions(promoCodeId: string) {
  const db = await getDb();
  const session = await requirePageAccess("/promo-codes");
  await requireCapability(session, "__can_view_promo_redemptions", "view promo redemptions");
  const redemptions = await db.promo_code_redemptions.findMany({
    where: { promo_code_id: promoCodeId },
    include: {
      user: { select: { username: true, email: true, image: true } },
    },
    orderBy: { redeemed_at: "desc" },
    take: 100,
  });
  return redemptions.map((r) => ({
    id: r.id,
    userId: r.user_id,
    username: r.user?.username ?? null,
    email: r.user?.email ?? null,
    image: r.user?.image ?? null,
    ipAddress: r.ip_address,
    redeemedAt: r.redeemed_at.toISOString(),
  }));
}

export async function deletePromoCode(promoCodeId: string) {
  const db = await getDb();
  const session = await requirePageAccess("/promo-codes");
  await requireCapability(session, "__can_delete_promo_code", "delete promo codes");

  // `deleteMany` is idempotent — returns `{ count: 0 }` instead of
  // throwing P2025 when the record is already gone. Important for the
  // list-page UX where a stuck-open AlertDialog could let an admin
  // double-click and trigger a second delete on a row that already
  // disappeared from the table on the first click. The audit row only
  // gets written if at least one record was actually deleted.
  const result = await db.promo_codes.deleteMany({
    where: { id: promoCodeId },
  });

  if (result.count > 0) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "promo_code_deleted",
      metadata: { promo_code_id: promoCodeId },
    });
  }

  revalidatePath("/promo-codes");
  return { deleted: result.count };
}

/**
 * Delete a batch of promo codes by id. Used by the row-selection
 * bulk-delete on /promo-codes. Idempotent — already-deleted ids are
 * just no-ops, the same way the single-delete handles double-clicks.
 *
 * Caps the input list at 1000 to keep the prepared statement
 * reasonable; nobody should be selecting more than that interactively.
 */
export async function deletePromoCodesBulk(promoCodeIds: string[]) {
  const db = await getDb();
  const session = await requirePageAccess("/promo-codes");
  await requireCapability(session, "__can_delete_promo_code", "delete promo codes");

  const ids = Array.from(new Set(promoCodeIds.filter(Boolean))).slice(0, 1000);
  if (ids.length === 0) {
    return { deleted: 0 };
  }

  const result = await db.promo_codes.deleteMany({
    where: { id: { in: ids } },
  });

  if (result.count > 0) {
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "promo_codes_bulk_deleted",
      metadata: { count: result.count, requested: ids.length, ids },
    });
  }

  revalidatePath("/promo-codes");
  return { deleted: result.count };
}
