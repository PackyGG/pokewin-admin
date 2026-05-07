"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createHash, randomBytes } from "crypto";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";

const createGiftCardSchema = z.object({
  value: z
    .number()
    .finite()
    .positive("Value must be positive")
    .max(10_000_000),
  region: z.enum(["NA", "EU"]),
  expiresAt: z.string().optional(),
  code: z.string().trim().max(64, "Code is too long").optional(),
});

export async function createGiftCard(data: z.infer<typeof createGiftCardSchema>) {
  const db = await getDb();
  const session = await requirePageAccess("/gift-cards");
  await requireCapability(session, "__can_create_gift_card", "create gift cards");

  const parsed = createGiftCardSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid gift card input");
  }
  const v = parsed.data;

  const code = v.code || randomBytes(8).toString("hex").toUpperCase();
  const codeHash = createHash("sha256").update(code).digest("hex");

  const card = await db.gift_cards.create({
    data: {
      value: v.value,
      region: v.region,
      code,
      code_hash: codeHash,
      expires_at: v.expiresAt ? new Date(v.expiresAt) : null,
    },
  });

  await adminDb.admin_gift_card_actions.create({
    data: {
      gift_card_id: card.id,
      action: "created",
      admin_user_id: session.userId,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "gift_card_created",
    metadata: { gift_card_id: card.id, value: v.value, region: v.region },
  });

  revalidatePath("/gift-cards");
}

export async function cancelGiftCard(giftCardId: string) {
  const db = await getDb();
  const session = await requirePageAccess("/gift-cards");
  await requireCapability(session, "__can_cancel_gift_card", "cancel gift cards");

  const card = await db.gift_cards.findUnique({ where: { id: giftCardId } });
  if (!card) throw new Error("Gift card not found");
  if (card.redeemed_at) throw new Error("Gift card has already been redeemed");

  // Check if already cancelled in admin DB
  const existing = await adminDb.admin_gift_card_actions.findFirst({
    where: { gift_card_id: giftCardId, action: "cancelled" },
  });
  if (existing) throw new Error("Gift card has already been cancelled");

  await adminDb.admin_gift_card_actions.create({
    data: {
      gift_card_id: giftCardId,
      action: "cancelled",
      admin_user_id: session.userId,
    },
    select: { id: true },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "gift_card_cancelled",
    metadata: { gift_card_id: giftCardId },
  });

  revalidatePath("/gift-cards");
}
