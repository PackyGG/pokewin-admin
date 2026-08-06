"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { createAdminAuditEvent } from "@/lib/admin-audit";
import { actionErrorMessage } from "@/lib/antifraud/action-error-message";
import {
  updateFiatAccessControl,
  type FiatAccessControlStatus,
} from "@/lib/antifraud/monitor-api";
import { requireAntifraudManager } from "@/lib/require-antifraud-access";

const inputSchema = z.object({
  scope: z.enum(["existing-accounts", "new-signups"]),
  enabled: z.boolean(),
});

export async function updateFiatDepositAccessControlAction(input: {
  scope: "existing-accounts" | "new-signups";
  enabled: boolean;
}): Promise<
  | { success: true; data: FiatAccessControlStatus }
  | { success: false; error: string }
> {
  const session = await requireAntifraudManager(
    "Only owners and admins can change Fiat access policies.",
  );
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid Fiat access policy." };
  try {
    const data = await updateFiatAccessControl({
      ...parsed.data,
      actorId: session.userId,
    });
    await createAdminAuditEvent({
      adminUserId: session.userId,
      eventType: "fiat_deposit_access_policy_updated",
      metadata: {
        scope: parsed.data.scope,
        enabled: parsed.data.enabled,
        generation:
          parsed.data.scope === "existing-accounts"
            ? data.existingAccounts.generation
            : data.newSignups.generation,
      },
    });
    revalidatePath("/antifraud/config");
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      // Narrowed: monitor-API fetch errors carry host/status internals.
      error: actionErrorMessage(error, "Fiat access policy update failed."),
    };
  }
}
