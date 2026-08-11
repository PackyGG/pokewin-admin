"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";

import { settleCreatorPnlDeal } from "@/lib/creator-pnl-settlement";
import { pnlDealsApi } from "@/lib/backend-api/pnl-deals";
import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";

const InputSchema = z.object({
  userId: z.string().trim().min(8).max(128),
  dealId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
});

export async function settleCreatorPnlDealAction(input: {
  userId: string;
  dealId: string;
  expectedVersion: number;
}): Promise<
  | { success: true; frameSitePnlUsd: number; creatorShareUsd: number }
  | { success: false; error: string }
> {
  await requireCreatorHubAccess("Not authorized to settle creator PnL deals.");
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid settlement request." };

  try {
    const result = await settleCreatorPnlDeal(parsed.data);
    revalidateTag("creator-deal");
    revalidatePath(`/creator-hub/creators/${parsed.data.userId}`);
    return {
      success: true,
      frameSitePnlUsd: result.breakdown.frame_site_pnl_usd,
      creatorShareUsd: Number(result.deal.creator_share_usd ?? 0),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "PnL settlement failed.",
    };
  }
}

const CancelSchema = InputSchema.pick({ userId: true, dealId: true }).extend({
  reason: z.string().trim().min(3).max(500),
});

export async function cancelCreatorPnlDealAction(input: {
  userId: string;
  dealId: string;
  reason: string;
}): Promise<{ success: true } | { success: false; error: string }> {
  await requireCreatorHubAccess("Not authorized to cancel creator PnL deals.");
  const parsed = CancelSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Enter a cancellation reason." };
  try {
    const current = await pnlDealsApi.get(parsed.data.userId, parsed.data.dealId);
    if (current.status !== "scheduled" && current.status !== "active") {
      return { success: false, error: `A ${current.status.replaceAll("_", " ")} PnL deal cannot be cancelled.` };
    }
    await pnlDealsApi.cancel(parsed.data.userId, parsed.data.dealId, {
      reason: parsed.data.reason,
    });
    revalidateTag("creator-deal");
    revalidatePath(`/creator-hub/creators/${parsed.data.userId}`);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "PnL cancellation failed." };
  }
}
