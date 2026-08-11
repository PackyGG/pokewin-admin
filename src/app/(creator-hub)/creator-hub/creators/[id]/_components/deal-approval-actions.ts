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

export type CreatorMultiplierApprovalPayload = {
  approval_expires_at: string;
  required_deposit_usd: number;
  multiplier_bps: number;
  withdrawable_bps: number;
  wager_requirement_bps: number;
  max_total_wager_usd: number | null;
  max_payout_usd: number | null;
  min_session_duration_seconds: number;
  min_bet_count: number;
  min_wager_to_funding_ratio_bps: number;
  kick_vod_required: boolean;
  auto_renew: boolean;
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
 * server-side from which payloads are present: a fill deal (optionally bundling
 * rewards/leaderboard), a multiplier deal, or one standalone add-on. Both deal
 * kinds require terms; standalone add-ons skip that step.
 */
export async function submitCreatorDealApproval(input: {
  creatorUserId: string;
  dealPayload: DealPayload | null;
  multiplierPayload?: CreatorMultiplierApprovalPayload | null;
  rewardPayload: CreatorRewardApprovalPayload | null;
  leaderboardPayload?: CreatorLeaderboardApprovalPayload | null;
}): Promise<
  | {
      success: true;
      requestId: string;
      status: string;
      deliveryQueued: boolean;
      kind: "deal" | "multiplier_deal" | "leaderboard_only" | "rewards_only";
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
