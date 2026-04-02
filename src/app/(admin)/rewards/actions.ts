"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { requireAdmin } from "@/lib/dal";
import { createAdminAuditEvent } from "@/lib/admin-audit";

export async function reloadPacks() {
  const res = await fetch(
    `${process.env.BACKEND_API_URL}/admin/reload-packs`,
    {
      method: "POST",
      headers: {
        "x-api-key": process.env.BACKEND_API_KEY!,
      },
    }
  );

  if (!res.ok) {
    console.error("Failed to reload packs cache:", await res.text().catch(() => "Unknown error"));
  }
}

function revalidateRewardPages() {
  revalidatePath("/rewards");
  revalidatePath("/rewards/level-up");
}

export async function createReward(data: {
  slug: string;
  name: string;
  type: "one_time" | "daily" | "balance";
  levelRequired?: number;
  packIds?: string[];
  cashAmount?: number;
  metadata?: Record<string, unknown>;
}) {
  const session = await requireAdmin();

  if (!data.slug.trim() || !data.name.trim()) {
    throw new Error("Slug and name are required");
  }

  let reward;
  try {
    reward = await db.rewards.create({
      data: {
        slug: data.slug.trim(),
        name: data.name.trim(),
        type: data.type,
        level_required: data.levelRequired ?? 0,
        pack_ids: data.packIds ?? [],
        cash_amount: data.cashAmount ?? null,
        metadata: data.metadata
          ? (data.metadata as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      throw new Error("A reward with this slug already exists");
    }
    throw e;
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "reward_created",
    metadata: { reward_id: reward.id, slug: reward.slug, type: reward.type },
  });

  await reloadPacks();

  revalidateRewardPages();
  return reward.id;
}

export async function updateReward(
  id: string,
  data: {
    slug: string;
    name: string;
    type: "one_time" | "daily" | "balance";
    levelRequired?: number;
    packIds?: string[];
    cashAmount?: number;
    metadata?: Record<string, unknown>;
  }
) {
  const session = await requireAdmin();

  if (!data.slug.trim() || !data.name.trim()) {
    throw new Error("Slug and name are required");
  }

  const reward = await db.rewards.update({
    where: { id },
    data: {
      slug: data.slug.trim(),
      name: data.name.trim(),
      type: data.type,
      level_required: data.levelRequired ?? 0,
      pack_ids: data.packIds ?? [],
      cash_amount: data.cashAmount ?? null,
      metadata: data.metadata
        ? (data.metadata as Prisma.InputJsonValue)
        : Prisma.JsonNull,
      updated_at: new Date(),
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "reward_updated",
    metadata: { reward_id: reward.id, slug: reward.slug, type: reward.type },
  });

  await reloadPacks();

  revalidateRewardPages();
  return reward.id;
}

export async function deleteReward(rewardId: string) {
  const session = await requireAdmin();

  await db.user_rewards.deleteMany({ where: { reward_id: rewardId } });
  await db.rewards.delete({ where: { id: rewardId } });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "reward_deleted",
    metadata: { reward_id: rewardId },
  });

  await reloadPacks();

  revalidateRewardPages();
}

export async function updateRakebackConfig(
  id: string,
  data: { percentage: number; expirationDays: number; enabled: boolean }
) {
  const session = await requireAdmin();

  await db.rakeback_config.update({
    where: { id },
    data: {
      percentage: data.percentage,
      expiration_days: data.expirationDays,
      enabled: data.enabled,
    },
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "rakeback_config_updated",
    metadata: { config_id: id, ...data },
  });

  revalidatePath("/rewards/rakeback");
  revalidatePath("/rewards/settings");
}
