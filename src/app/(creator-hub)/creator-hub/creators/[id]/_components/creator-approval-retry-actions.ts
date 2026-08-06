"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  provisionApprovedCreatorDealRequest,
  retryCreatorDealApprovalDelivery,
} from "@/lib/creator-deal-approvals";
import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";

const InputSchema = z.object({
  creatorUserId: z.string().trim().min(8).max(64),
  requestId: z.string().uuid(),
  step: z.enum(["delivery", "provisioning"]),
});

export async function retryCreatorApprovalAction(input: {
  creatorUserId: string;
  requestId: string;
  step: "delivery" | "provisioning";
}): Promise<{ success: true; status: string } | { success: false; error: string }> {
  const session = await requireCreatorHubAccess(
    "Not authorized to retry creator approvals.",
  );
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid retry request." };

  try {
    const result =
      parsed.data.step === "delivery"
        ? await retryCreatorDealApprovalDelivery({
            requestId: parsed.data.requestId,
            actorAdminUserId: session.userId,
          })
        : await provisionApprovedCreatorDealRequest(
            parsed.data.requestId,
            session.userId,
          );
    revalidatePath(`/creator-hub/creators/${parsed.data.creatorUserId}`);
    return { success: true, status: result.status };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "The retry failed.",
    };
  }
}
