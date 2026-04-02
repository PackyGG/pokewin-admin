"use server";

import { revalidatePath } from "next/cache";
import { createHash, randomBytes } from "crypto";
import { db } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";

export async function createGiftCard(data: {
  value: number;
  region: "NA" | "EU";
  expiresAt?: string;
  code?: string;
}) {
  const session = await requirePageAccess("/gift-cards");

  const code = data.code?.trim() || randomBytes(8).toString("hex").toUpperCase();
  const codeHash = createHash("sha256").update(code).digest("hex");

  const card = await db.gift_cards.create({
    data: {
      value: data.value,
      region: data.region,
      code,
      code_hash: codeHash,
      expires_at: data.expiresAt ? new Date(data.expiresAt) : null,
    },
  });

  await adminDb.admin_gift_card_actions.create({
    data: {
      gift_card_id: card.id,
      action: "created",
      admin_user_id: session.userId,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "gift_card_created",
    metadata: { gift_card_id: card.id, value: data.value, region: data.region },
  });

  revalidatePath("/gift-cards");
}

export async function cancelGiftCard(giftCardId: string) {
  const session = await requirePageAccess("/gift-cards");

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
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "gift_card_cancelled",
    metadata: { gift_card_id: giftCardId },
  });

  revalidatePath("/gift-cards");
}
