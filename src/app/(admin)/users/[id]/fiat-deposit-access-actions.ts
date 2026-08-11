"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEventDurable } from "@/lib/admin-audit";
import {
  getFiatEligibilityOverride,
  updateFiatEligibilityOverride,
  type FiatEligibilityOverride,
} from "@/lib/antifraud/fiat-eligibility-overrides-api";
import {
  getFiatDepositAccess,
  updateFiatDepositAccess,
  type FiatDepositAccess,
} from "@/lib/backend-api/fiat-deposit-access";
import { BackendApiError } from "@/lib/backend-api/errors";
import { requireAdmin, requirePageAccess } from "@/lib/dal";

type Result =
  | { success: true; data: FiatDepositAccess }
  | { success: false; error: string };

type OverrideResult =
  | { success: true; data: FiatEligibilityOverride }
  | { success: false; error: string };

const userIdSchema = z.string().trim().min(1, "Invalid user id");

const updateAccessSchema = z.object({
  userId: userIdSchema,
  enabled: z.boolean(),
});

function friendlyError(error: unknown): string {
  if (error instanceof BackendApiError) {
    if (error.isNotFound) return "User not found in backend";
    if (error.status === 401 || error.status === 403) {
      return "Fiat access API credentials were rejected";
    }
    return error.message;
  }
  if (error instanceof Error && error.message.startsWith("Missing ")) {
    return "Fiat access API is not configured";
  }
  return "Fiat access API is currently unavailable";
}

export async function updateFiatDepositAccessAction(
  userId: string,
  enabled: boolean,
): Promise<Result> {
  await requirePageAccess("/users");
  const session = await requireAdmin();
  const parsed = updateAccessSchema.safeParse({ userId, enabled });
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }

  let previous: FiatDepositAccess | null = null;
  try {
    previous = await getFiatDepositAccess(parsed.data.userId);
  } catch {
    // The PUT remains useful when the status read is temporarily unavailable.
  }

  let updated: FiatDepositAccess;
  try {
    updated = await updateFiatDepositAccess(
      parsed.data.userId,
      parsed.data.enabled,
    );
  } catch (error) {
    return { success: false, error: friendlyError(error) };
  }

  await createAdminAuditEventDurable({
    adminUserId: session.userId,
    eventType: "user_fiat_deposit_access_updated",
    targetUserId: parsed.data.userId,
    metadata: {
      previousEnabled: previous?.enabled ?? null,
      enabled: updated.enabled,
    },
  });

  revalidatePath(`/users/${parsed.data.userId}`, "page");

  return { success: true, data: updated };
}

export async function updatePreFiatAlwaysAllowAction(
  userId: string,
  enabled: boolean,
): Promise<OverrideResult> {
  await requirePageAccess("/users");
  const session = await requireAdmin();
  const parsed = updateAccessSchema.safeParse({ userId, enabled });
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0].message };
  }

  let previous: FiatEligibilityOverride | null = null;
  try {
    previous = await getFiatEligibilityOverride(parsed.data.userId);
  } catch {
    // The audited PUT remains safe and useful when the status read fails.
  }

  const reason = parsed.data.enabled
    ? "Enabled from the user Account tab Fiat Deposit Allow-list."
    : "Disabled from the user Account tab Fiat Deposit Allow-list.";
  let updated: FiatEligibilityOverride;
  try {
    updated = await updateFiatEligibilityOverride({
      userId: parsed.data.userId,
      enabled: parsed.data.enabled,
      reason,
      actorId: session.userId,
      actorUsername: session.username ?? undefined,
      idempotencyKey: randomUUID(),
    });
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error
        ? error.message
        : "The pre-Fiat override is unavailable.",
    };
  }

  await createAdminAuditEventDurable({
    adminUserId: session.userId,
    eventType: "user_pre_fiat_always_allow_updated",
    targetUserId: parsed.data.userId,
    metadata: {
      previousEnabled: previous?.enabled ?? null,
      enabled: updated.enabled,
      environment: updated.environment,
    },
  });
  revalidatePath(`/users/${parsed.data.userId}`, "page");
  return { success: true, data: updated };
}
