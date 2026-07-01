"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { backendApi, BackendApiError } from "@/lib/backend-api";

export async function reloadPacks() {
  // Routes through the central backendApi client so env-specific URL+key,
  // CF Access service tokens, and `x-bypass-secret` are all picked up.
  try {
    await backendApi.post("/admin/reload-packs");
    console.log("[reloadPacks] backend ok");
  } catch (err) {
    if (err instanceof BackendApiError) {
      console.error(
        `[reloadPacks] backend error status=${err.status} code=${err.code ?? "none"} payload=${JSON.stringify(err.payload)}`,
      );
      return;
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[reloadPacks] failed to reach backend: ${message}`, err);
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
  /** Daily rewards only. Fraction (0.01 = 1%). null/undefined = 1% default. */
  dailyUnlockPercentage?: number | null;
  metadata?: Record<string, unknown>;
}) {
  const db = await getDb();
  const session = await requireAdmin();

  if (!data.slug.trim() || !data.name.trim()) {
    throw new Error("Slug and name are required");
  }

  await requireCapability(session, "__can_create_reward", "create rewards");

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
        daily_unlock_percentage:
          data.type === "daily" ? data.dailyUnlockPercentage ?? null : null,
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
    /** Daily rewards only. Fraction (0.01 = 1%). null/undefined = 1% default. */
    dailyUnlockPercentage?: number | null;
    metadata?: Record<string, unknown>;
  }
) {
  const db = await getDb();
  const session = await requireAdmin();

  if (!data.slug.trim() || !data.name.trim()) {
    throw new Error("Slug and name are required");
  }

  await requireCapability(session, "__can_update_reward", "update rewards");

  const reward = await db.rewards.update({
    where: { id },
    data: {
      slug: data.slug.trim(),
      name: data.name.trim(),
      type: data.type,
      level_required: data.levelRequired ?? 0,
      pack_ids: data.packIds ?? [],
      cash_amount: data.cashAmount ?? null,
      daily_unlock_percentage:
        data.type === "daily" ? data.dailyUnlockPercentage ?? null : null,
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
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_delete_reward", "delete rewards");

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
  const db = await getDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_update_rakeback", "update rakeback config");

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

  revalidatePath("/rewards");
  revalidatePath("/rewards/settings");
}
