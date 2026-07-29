"use server";

import { createAdminAuditEvent } from "@/lib/admin-audit";
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

function validUserId(userId: string): boolean {
  return typeof userId === "string" && userId.trim().length > 0;
}

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

export async function getFiatDepositAccessAction(
  userId: string,
): Promise<Result> {
  await requirePageAccess("/users");
  await requireAdmin();
  if (!validUserId(userId)) {
    return { success: false, error: "Invalid user id" };
  }
  try {
    return { success: true, data: await getFiatDepositAccess(userId) };
  } catch (error) {
    return { success: false, error: friendlyError(error) };
  }
}

export async function updateFiatDepositAccessAction(
  userId: string,
  enabled: boolean,
): Promise<Result> {
  await requirePageAccess("/users");
  const session = await requireAdmin();
  if (!validUserId(userId) || typeof enabled !== "boolean") {
    return { success: false, error: "Invalid Fiat access request" };
  }

  let previous: FiatDepositAccess | null = null;
  try {
    previous = await getFiatDepositAccess(userId);
  } catch {
    // The PUT remains useful when the status read is temporarily unavailable.
  }

  let updated: FiatDepositAccess;
  try {
    updated = await updateFiatDepositAccess(userId, enabled);
  } catch (error) {
    return { success: false, error: friendlyError(error) };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "user_fiat_deposit_access_updated",
    targetUserId: userId,
    metadata: {
      previousEnabled: previous?.enabled ?? null,
      enabled: updated.enabled,
    },
  });

  return { success: true, data: updated };
}
