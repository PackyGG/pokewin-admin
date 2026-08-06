"use server";

import { eq } from "drizzle-orm";

import { createCreatorDealApprovalRequest } from "@/lib/creator-deal-approvals";
import { getProdReadDrizzleDb } from "@/lib/db";
import { affiliate_codes, user } from "@/lib/db-schema/main/schema";
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
  /** Only sent by the standalone rewards dialog; a bundled program always
   *  inherits the deal window server-side. */
  startsAt?: string | null;
  endsAt?: string | null;
};

export type CreatorLeaderboardApprovalPayload = {
  title: string;
  prizeTiers: Array<{ position: number; prizeAmountUsd: number }>;
  siteBonusUsd: number;
  /** House share of the prize pool, 0-100. Cost accounting only. */
  sponsoredPct: number;
  /** Sent for shape completeness only — the server always overwrites both the
   *  codes and the window from the creator and the request. */
  codes: string[];
  startsAt: string;
  endsAt: string;
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

/** Creator's display name for auto-generated leaderboard titles ("<name> Leaderboard"). */
export async function loadCreatorNameForApproval(
  creatorUserId: string,
): Promise<string> {
  await requireCreatorHubAccess("Not authorized to prepare creator deals.");
  const [row] = await getProdReadDrizzleDb()
    .select({ username: user.username })
    .from(user)
    .where(eq(user.id, creatorUserId))
    .limit(1);
  return row?.username?.trim() || creatorUserId;
}

/**
 * Queue a creator approval request for Discord. The kind is inferred
 * server-side from which payloads are present: a deal (optionally bundling a
 * reward program and/or a leaderboard), or exactly one standalone leaderboard
 * or reward program — the standalone kinds skip the terms step entirely.
 */
export async function submitCreatorDealApproval(input: {
  creatorUserId: string;
  dealPayload: DealPayload | null;
  rewardPayload: CreatorRewardApprovalPayload | null;
  leaderboardPayload?: CreatorLeaderboardApprovalPayload | null;
}): Promise<
  | {
      success: true;
      requestId: string;
      status: string;
      deliveryQueued: boolean;
      kind: "deal" | "leaderboard_only" | "rewards_only";
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
