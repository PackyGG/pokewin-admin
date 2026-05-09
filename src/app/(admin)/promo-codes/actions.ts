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
  minimumDepositAmount: z.number().finite().nonnegative().max(10_000_000),
  requiredAffiliateCode: z.string().trim().toUpperCase().max(32).nullable(),
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

  const pepper = process.env.GIFT_CARD_PEPPER ?? "";
  const normalizedCode = v.code.toUpperCase().trim();
  const codeHash = createHash("sha256").update(normalizedCode + pepper).digest("hex");

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
      minimum_deposit_amount: v.minimumDepositAmount,
      required_affiliate_code: v.requiredAffiliateCode || null,
      requires_discord: v.requiresDiscord,
      max_uses: v.maxUses,
      expires_at: v.expiresAt ? new Date(v.expiresAt) : null,
      metadata: { code: normalizedCode },
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

  await db.promo_codes.delete({ where: { id: promoCodeId } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "promo_code_deleted",
    metadata: { promo_code_id: promoCodeId },
  });

  revalidatePath("/promo-codes");
}
