"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import type { race_type } from "@/generated/prisma/enums";

const VALID_RACE_TYPES = new Set<race_type>(["daily", "weekly"]);

/**
 * Create or update a race prize tier. The unique key on the table is
 * (race_type, position), so we upsert on that pair — both "edit the
 * prize for daily #1" and "add a new weekly #4" go through this one
 * action. Called from the inline edit and the "Add Tier" form on
 * /rewards/leaderboards → Prize Tiers tab.
 */
export async function upsertRacePrizeTier(
  raceType: string,
  position: number,
  prizeAmountUsd: number,
) {
  const db = await getDb();
  const session = await requireAdmin();

  if (!VALID_RACE_TYPES.has(raceType as race_type)) {
    throw new Error("Invalid race type (must be daily or weekly)");
  }
  if (!Number.isInteger(position) || position < 1) {
    throw new Error("Position must be a positive integer");
  }
  if (!Number.isFinite(prizeAmountUsd) || prizeAmountUsd < 0) {
    throw new Error("Prize amount must be a non-negative number");
  }

  await requireCapability(
    session,
    "__can_upsert_race_prize_tier",
    "upsert race prize tiers",
  );

  const existing = await db.race_prize_tiers.findFirst({
    where: { race_type: raceType as race_type, position },
    select: { id: true, prize_amount_usd: true },
  });

  if (existing) {
    await db.race_prize_tiers.update({
      where: { id: existing.id },
      data: { prize_amount_usd: prizeAmountUsd },
    });
  } else {
    await db.race_prize_tiers.create({
      data: {
        race_type: raceType as race_type,
        position,
        prize_amount_usd: prizeAmountUsd,
      },
    });
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: existing
      ? "race_prize_tier_updated"
      : "race_prize_tier_created",
    metadata: {
      race_type: raceType,
      position,
      prize_amount_usd: prizeAmountUsd,
      ...(existing
        ? { old_prize_amount_usd: Number(existing.prize_amount_usd) }
        : {}),
    },
  });

  revalidatePath("/rewards/leaderboards");
}

/**
 * Remove a race prize tier. Used when an admin wants to stop awarding
 * a specific position — e.g. dropping weekly #10 after shrinking the
 * podium. Deletion is hard; no soft-delete column on the table.
 */
export async function deleteRacePrizeTier(id: string) {
  const db = await getDb();
  const session = await requireAdmin();

  const existing = await db.race_prize_tiers.findUnique({
    where: { id },
    select: { race_type: true, position: true, prize_amount_usd: true },
  });
  if (!existing) {
    throw new Error("Prize tier not found");
  }

  await requireCapability(
    session,
    "__can_delete_race_prize_tier",
    "delete race prize tiers",
  );

  await db.race_prize_tiers.delete({ where: { id } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "race_prize_tier_deleted",
    metadata: {
      tier_id: id,
      race_type: existing.race_type,
      position: existing.position,
      prize_amount_usd: Number(existing.prize_amount_usd),
    },
  });

  revalidatePath("/rewards/leaderboards");
}
