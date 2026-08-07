"use server";

import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { getPrimaryDrizzleDb } from "@/lib/db";
import {
  rakeback_config,
  rewards,
  user_rewards,
} from "@/lib/db-schema/main/schema";
import { requireAdmin } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";
import { createAdminAuditEvent } from "@/lib/admin-audit";
import { reloadPacksInternal } from "@/lib/packs/reload-packs";

async function reloadPacks() {
  // A Server Action is a callable POST endpoint, so it carries its OWN
  // authorization — the middleware only proves a session exists, it never
  // checks role, and Next explicitly does not treat it as an action guard.
  // Without this, any signed-in panel user (support / marketing / creator /
  // pack_creator) could drive a privileged backend reload that every other
  // action in this file gates behind `requireAdmin`.
  //
  // Internal callers (this file + packs/actions.ts) that are already
  // capability-gated call `reloadPacksInternal` directly instead — routing
  // them through this gate broke the reload for capability-holding
  // non-admins (requireAdmin rejects with NEXT_REDIRECT).
  await requireAdmin();
  await reloadPacksInternal();
}

const rewardInputSchema = z.object({
  slug: z.string().trim().min(1, "Slug is required").max(100, "Slug is too long"),
  name: z.string().trim().min(1, "Name is required").max(200, "Name is too long"),
  type: z.enum(["one_time", "daily", "balance"]),
  levelRequired: z.number().int().nonnegative().max(1_000).optional(),
  packIds: z.array(z.string().trim().min(1)).max(500).optional(),
  cashAmount: z
    .number()
    .finite()
    .nonnegative("Cash amount cannot be negative")
    .max(10_000_000)
    .optional(),
  // Daily rewards only. Fraction of wagered amount (0.01 = 1%).
  dailyUnlockPercentage: z
    .number()
    .finite()
    .min(0)
    .max(1, "Daily unlock percentage is a fraction (0.01 = 1%, max 1)")
    .nullish(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function revalidateRewardPages() {
  // Rewards list + level-up + rakeback + settings all live under the /rewards
  // tab hub now, so a single revalidate of /rewards refreshes every tab.
  revalidatePath("/rewards");
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
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();

  const parsed = rewardInputSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid reward input");
  }
  const v = parsed.data;

  await requireCapability(session, "__can_create_reward", "create rewards");

  let reward: typeof rewards.$inferSelect | undefined;
  try {
    [reward] = await db
      .insert(rewards)
      .values({
        slug: v.slug,
        name: v.name,
        type: v.type,
        level_required: v.levelRequired ?? 0,
        pack_ids: v.packIds ?? [],
        cash_amount: v.cashAmount == null ? null : String(v.cashAmount),
        daily_unlock_percentage:
          v.type === "daily" && v.dailyUnlockPercentage != null
            ? String(v.dailyUnlockPercentage)
            : null,
        metadata: v.metadata ?? null,
      })
      .returning();
  } catch (e) {
    if ((e as { code?: string })?.code === "23505") {
      throw new Error("A reward with this slug already exists");
    }
    throw e;
  }
  if (!reward) throw new Error("Reward insert returned no row");

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "reward_created",
    metadata: { reward_id: reward.id, slug: reward.slug, type: reward.type },
  });

  await reloadPacksInternal();

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
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();

  const parsed = rewardInputSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message ?? "Invalid reward input");
  }
  const v = parsed.data;

  await requireCapability(session, "__can_update_reward", "update rewards");

  let reward: typeof rewards.$inferSelect | undefined;
  try {
    [reward] = await db
      .update(rewards)
      .set({
        slug: v.slug,
        name: v.name,
        type: v.type,
        level_required: v.levelRequired ?? 0,
        pack_ids: v.packIds ?? [],
        cash_amount: v.cashAmount == null ? null : String(v.cashAmount),
        daily_unlock_percentage:
          v.type === "daily" && v.dailyUnlockPercentage != null
            ? String(v.dailyUnlockPercentage)
            : null,
        metadata: v.metadata ?? null,
        updated_at: new Date().toISOString(),
      })
      .where(eq(rewards.id, id))
      .returning();
  } catch (e) {
    // Same friendly mapping createReward uses — renaming a reward onto an
    // existing slug is a user error, not a 500.
    if ((e as { code?: string })?.code === "23505") {
      throw new Error("A reward with this slug already exists");
    }
    throw e;
  }
  if (!reward) throw new Error("Reward not found");

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "reward_updated",
    metadata: { reward_id: reward.id, slug: reward.slug, type: reward.type },
  });

  await reloadPacksInternal();

  revalidateRewardPages();
  return reward.id;
}

export async function deleteReward(rewardId: string) {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_delete_reward", "delete rewards");

  await db.transaction(async (tx) => {
    await tx.delete(user_rewards).where(eq(user_rewards.reward_id, rewardId));
    const deleted = await tx
      .delete(rewards)
      .where(eq(rewards.id, rewardId))
      .returning({ id: rewards.id });
    if (!deleted[0]) throw new Error("Reward not found");
  });

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "reward_deleted",
    metadata: { reward_id: rewardId },
  });

  await reloadPacksInternal();

  revalidateRewardPages();
}

export async function updateRakebackConfig(
  id: string,
  data: { percentage: number; expirationDays: number; enabled: boolean }
) {
  const db = await getPrimaryDrizzleDb();
  const session = await requireAdmin();
  await requireCapability(session, "__can_update_rakeback", "update rakeback config");

  const updated = await db
    .update(rakeback_config)
    .set({
      percentage: String(data.percentage),
      expiration_days: data.expirationDays,
      enabled: data.enabled,
      updated_at: new Date().toISOString(),
    })
    .where(eq(rakeback_config.id, id))
    .returning({ id: rakeback_config.id });
  if (!updated[0]) throw new Error("Rakeback config not found");

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "rakeback_config_updated",
    metadata: { config_id: id, ...data },
  });

  // Rakeback config surfaces on both the Rakeback and Settings tabs of the
  // /rewards hub — a single revalidate refreshes both.
  revalidatePath("/rewards");
}
