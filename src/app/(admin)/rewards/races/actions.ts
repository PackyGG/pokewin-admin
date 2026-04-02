"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";

export async function updateRacePrizeTier(id: string, prizeAmountUsd: number) {
  const session = await requireAdmin();

  await db.race_prize_tiers.update({
    where: { id },
    data: { prize_amount_usd: prizeAmountUsd },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "race_prize_tier_updated",
    metadata: { tier_id: id, prize_amount_usd: prizeAmountUsd },
  });

  revalidatePath("/rewards/races");
}
