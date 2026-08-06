"use server";

import { eq } from "drizzle-orm";

import { createCreatorDealApprovalRequest } from "@/lib/creator-deal-approvals";
import { getProdReadDrizzleDb } from "@/lib/db";
import { affiliate_codes } from "@/lib/db-schema/main/schema";
import { requireCreatorHubAccess } from "@/lib/require-creator-hub-access";

import type { DealPayload } from "./deal-form-shared";

export type CreatorRewardApprovalPayload = {
  name: string;
  codes: string[];
  thresholdUsd: number | null;
  rewardUsd: number | null;
  vipRewardUsd: number | null;
  lossbackPct: number | null;
  minDepositUsd: number | null;
  maxRewardPerUserUsd: number | null;
};

export async function loadCreatorCodesForApproval(
  creatorUserId: string,
): Promise<string[]> {
  await requireCreatorHubAccess("Not authorized to prepare creator deals.");
  const rows = await getProdReadDrizzleDb()
    .select({ code: affiliate_codes.code })
    .from(affiliate_codes)
    .where(eq(affiliate_codes.user_id, creatorUserId));
  return [...new Set(rows.map((row) => row.code.trim().toUpperCase()))].filter(
    Boolean,
  );
}

export async function submitCreatorDealApproval(input: {
  creatorUserId: string;
  dealPayload: DealPayload;
  rewardPayload: CreatorRewardApprovalPayload | null;
}): Promise<
  | {
      success: true;
      requestId: string;
      status: string;
      deliveryQueued: boolean;
    }
  | { success: false; error: string }
> {
  try {
    const session = await requireCreatorHubAccess(
      "Not authorized to submit creator deals.",
    );
    const result = await createCreatorDealApprovalRequest({
      ...input,
      submittedByAdminUserId: session.userId,
    });
    return { success: true, ...result };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Could not queue the creator approval.",
    };
  }
}
