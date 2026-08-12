export type CreatorApprovalProvisioningState = {
  requestKind: "deal" | "multiplier_deal" | "pnl_deal" | "leaderboard_only" | "rewards_only";
  backendDealId: string | null;
  pnlDealId: string | null;
  rewardPayloadPresent: boolean;
  rewardProgramId: string | null;
  leaderboardPayloadPresent: boolean;
  leaderboardId: string | null;
};

export function creatorApprovalWindowHasEnded(
  windowEndAt: string | Date,
  now = new Date(),
): boolean {
  const windowEndMs = new Date(windowEndAt).getTime();
  const nowMs = now.getTime();
  // Invalid persisted windows fail closed instead of authorizing creation.
  return !Number.isFinite(windowEndMs) || !Number.isFinite(nowMs) || windowEndMs <= nowMs;
}

/**
 * An elapsed request may only finish the local, idempotent status transition
 * when every asset it approved is already durably bound to the request.
 * Missing bindings must fail closed because continuing could create a new
 * deal, reward program, or leaderboard after its commercial window ended.
 */
export function hasAllCreatorApprovalAssets(
  state: CreatorApprovalProvisioningState,
): boolean {
  const hasReward = !state.rewardPayloadPresent || state.rewardProgramId !== null;
  const hasLeaderboard = !state.leaderboardPayloadPresent || state.leaderboardId !== null;

  switch (state.requestKind) {
    case "deal":
      return state.backendDealId !== null && hasReward && hasLeaderboard;
    case "multiplier_deal":
      return state.backendDealId !== null;
    case "pnl_deal":
      return state.backendDealId !== null
        && state.pnlDealId !== null
        && hasReward
        && hasLeaderboard;
    case "leaderboard_only":
      return state.leaderboardId !== null;
    case "rewards_only":
      return state.rewardProgramId !== null;
  }
}
