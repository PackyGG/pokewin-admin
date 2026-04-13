"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { createHash } from "crypto";
import { createAdminAuditEvent } from "@/lib/admin-audit";

export async function createPromoCode(data: {
  code: string;
  value: number;
  region: "NA" | "EU";
  minimumLevel: number;
  minimumWagerAmount: number;
  wagerPeriodDays: number;
  minimumAccountAgeDays: number;
  requiresDiscord: boolean;
  maxUses: number;
  expiresAt: string | null;
}) {
  const session = await requirePageAccess("/promo-codes");

  const codeHash = createHash("sha256").update(data.code.toUpperCase()).digest("hex");

  const existing = await db.promo_codes.findFirst({
    where: { code_hash: codeHash },
  });
  if (existing) throw new Error("A promo code with this value already exists");

  await db.promo_codes.create({
    data: {
      id: crypto.randomUUID(),
      code_hash: codeHash,
      value: data.value,
      region: data.region,
      minimum_level: data.minimumLevel,
      minimum_wager_amount: data.minimumWagerAmount,
      wager_period_days: data.wagerPeriodDays,
      minimum_account_age_days: data.minimumAccountAgeDays,
      requires_discord: data.requiresDiscord,
      max_uses: data.maxUses,
      expires_at: data.expiresAt ? new Date(data.expiresAt) : null,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "promo_code_created",
    metadata: { code_hash: codeHash, value: data.value, region: data.region },
  });

  revalidatePath("/promo-codes");
}

export async function getRedemptions(promoCodeId: string) {
  await requirePageAccess("/promo-codes");
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
  const session = await requirePageAccess("/promo-codes");

  await db.promo_codes.delete({ where: { id: promoCodeId } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "promo_code_deleted",
    metadata: { promo_code_id: promoCodeId },
  });

  revalidatePath("/promo-codes");
}
