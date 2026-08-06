"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import {
  getFiatDepositAutomaticCreditConfig,
  updateFiatDepositAutomaticCreditConfig,
  type FiatDepositAutomaticCreditConfig,
} from "@/lib/backend-api/fiat-deposit-review";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";

const InputSchema = z.object({ enabled: z.boolean() });

export async function updateFiatAutomaticCreditAction(input: {
  enabled: boolean;
}): Promise<
  | { success: true; data: FiatDepositAutomaticCreditConfig }
  | { success: false; error: string }
> {
  const session = await requireAntifraudManager(
    "Only owners and admins can change global Fiat approval.",
  );

  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message ?? "Invalid setting",
    };
  }

  let previous: FiatDepositAutomaticCreditConfig | null = null;
  try {
    previous = await getFiatDepositAutomaticCreditConfig();
  } catch {
    previous = null;
  }

  let updated: FiatDepositAutomaticCreditConfig;
  try {
    updated = await updateFiatDepositAutomaticCreditConfig(
      parsed.data.enabled,
      session.userId,
    );
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Fiat automatic-credit service is unavailable",
    };
  }

  await createAdminAuditEvent({
    adminUserId: session.userId,
    eventType: "fiat_deposit_automatic_credit_updated",
    metadata: {
      old: previous?.fiat_deposit_automatic_credit_enabled ?? null,
      new: updated.fiat_deposit_automatic_credit_enabled,
    },
  });

  revalidatePath("/antifraud/config");
  revalidatePath("/antifraud/fiat-deposits");
  revalidatePath("/transactions/deposits");
  return { success: true, data: updated };
}
