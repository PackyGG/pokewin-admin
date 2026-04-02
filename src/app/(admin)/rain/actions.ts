"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePageAccess } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { toNumber } from "@/lib/utils/decimal";

export async function adjustRainBase(rainId: string, newBaseAmount: number) {
  const session = await requirePageAccess("/rain");

  if (newBaseAmount < 0) throw new Error("Base amount cannot be negative");

  const rain = await db.rains.findUnique({ where: { id: rainId } });
  if (!rain) throw new Error("Rain not found");
  if (rain.status !== "active") throw new Error("Can only adjust active rains");

  const totalPool = newBaseAmount + toNumber(rain.tip_amount_usd);

  await db.rains.update({
    where: { id: rainId },
    data: {
      base_amount_usd: newBaseAmount,
      total_pool_usd: totalPool,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "rain_base_adjusted",
    metadata: {
      rain_id: rainId,
      old_base: toNumber(rain.base_amount_usd),
      new_base: newBaseAmount,
      new_total: totalPool,
    },
  });

  revalidatePath("/rain");
  revalidatePath(`/rain/${rainId}`);
}

