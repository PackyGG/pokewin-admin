"use server";

import { revalidateTag } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  getUserFeatureLocks,
  updateUserFiatDepositAutoApproval,
  updateUserRewardLocks,
  type FiatDepositAutoApproval,
  type UserFeatureLocks,
} from "@/lib/backend-api/feature-locks";
import { BackendApiError } from "@/lib/backend-api/errors";
import { REWARD_LOCK_CATEGORIES } from "@/lib/contracts/reward-locks";
import { requireAdmin, requirePageAccess } from "@/lib/dal";
import { requireCapability } from "@/lib/require-capability";

const UserIdSchema = z.string().trim().min(1, "Invalid user id");

const RewardLocksSchema = z.object({
  userId: UserIdSchema,
  categories: z
    .array(z.enum(REWARD_LOCK_CATEGORIES))
    .max(REWARD_LOCK_CATEGORIES.length),
});

const FiatAutoApprovalSchema = z.object({
  userId: UserIdSchema,
  enabled: z.boolean(),
});

function friendlyError(error: unknown): string {
  if (error instanceof BackendApiError) {
    if (error.isNotFound) return "User not found in backend";
    if (error.status === 401 || error.status === 403) {
      return "Backend credentials were rejected";
    }
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "Backend feature-lock service is unavailable";
}

export async function updateUserRewardLocksAction(input: {
  userId: string;
  categories: string[];
}): Promise<
  { success: true; data: UserFeatureLocks } | { success: false; error: string }
> {
  const session = await requirePageAccess("/users");
  await requireCapability(
    session,
    "__can_toggle_feature_locks",
    "toggle reward feature locks",
  );

  const parsed = RewardLocksSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid reward locks",
    };
  }

  const categories = [...new Set(parsed.data.categories)];
  let previous: UserFeatureLocks | null = null;
  try {
    previous = await getUserFeatureLocks(parsed.data.userId);
  } catch {
    previous = null;
  }

  let updated: UserFeatureLocks;
  try {
    updated = await updateUserRewardLocks(
      parsed.data.userId,
      categories,
      session.userId,
    );
  } catch (error) {
    return { success: false, error: friendlyError(error) };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_reward_locks_updated",
    targetUserId: parsed.data.userId,
    metadata: {
      old: previous?.locked_reward_categories ?? null,
      new: updated.locked_reward_categories,
    },
  });

  revalidateTag(`users-detail-${parsed.data.userId}`);
  return { success: true, data: updated };
}

export async function updateUserFiatAutoApprovalAction(input: {
  userId: string;
  enabled: boolean;
}): Promise<
  | { success: true; data: FiatDepositAutoApproval }
  | { success: false; error: string }
> {
  await requirePageAccess("/users");
  const session = await requireAdmin();

  const parsed = FiatAutoApprovalSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid Fiat override",
    };
  }

  let previous: boolean | null = null;
  try {
    previous = (
      await getUserFeatureLocks(parsed.data.userId)
    ).fiat_deposit_auto_approval_enabled;
  } catch {
    previous = null;
  }

  let updated: FiatDepositAutoApproval;
  try {
    updated = await updateUserFiatDepositAutoApproval(
      parsed.data.userId,
      parsed.data.enabled,
      session.userId,
    );
  } catch (error) {
    return { success: false, error: friendlyError(error) };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_fiat_auto_approval_updated",
    targetUserId: parsed.data.userId,
    metadata: { old: previous, new: updated.enabled },
  });

  revalidateTag(`users-detail-${parsed.data.userId}`);
  return { success: true, data: updated };
}
