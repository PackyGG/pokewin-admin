import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  creatorApprovalWindowHasEnded,
  hasAllCreatorApprovalAssets,
  type CreatorApprovalProvisioningState,
} from "../../src/lib/creator-deal-provisioning-window";

const complete = (overrides: Partial<CreatorApprovalProvisioningState> = {}): CreatorApprovalProvisioningState => ({
  requestKind: "deal",
  backendDealId: "backend-deal",
  pnlDealId: null,
  rewardPayloadPresent: true,
  rewardProgramId: "reward-program",
  leaderboardPayloadPresent: true,
  leaderboardId: "leaderboard",
  ...overrides,
});

test("provisioning expiry is based on retry time, with an exclusive window end", () => {
  const end = "2026-08-12T12:00:00.000Z";
  assert.equal(creatorApprovalWindowHasEnded(end, new Date("2026-08-12T11:59:59.999Z")), false);
  assert.equal(creatorApprovalWindowHasEnded(end, new Date(end)), true);
  assert.equal(creatorApprovalWindowHasEnded(end, new Date("2026-08-12T12:00:00.001Z")), true);
  assert.equal(creatorApprovalWindowHasEnded("invalid", new Date("2026-08-12T11:00:00.000Z")), true);
});

test("elapsed retries can finalize only when every approved asset is already bound", () => {
  assert.equal(hasAllCreatorApprovalAssets(complete()), true, "a fully provisioned fill bundle may finalize");
  assert.equal(hasAllCreatorApprovalAssets(complete({ backendDealId: null })), false, "a missing fill deal must not be created");
  assert.equal(hasAllCreatorApprovalAssets(complete({ rewardProgramId: null })), false, "a missing reward program must not be created");
  assert.equal(hasAllCreatorApprovalAssets(complete({ leaderboardId: null })), false, "a missing leaderboard must not be created");

  assert.equal(hasAllCreatorApprovalAssets(complete({
    requestKind: "multiplier_deal",
    rewardPayloadPresent: false,
    rewardProgramId: null,
    leaderboardPayloadPresent: false,
    leaderboardId: null,
  })), true);
  assert.equal(hasAllCreatorApprovalAssets(complete({
    requestKind: "multiplier_deal",
    backendDealId: null,
  })), false);

  assert.equal(hasAllCreatorApprovalAssets(complete({ requestKind: "pnl_deal", pnlDealId: "pnl-deal" })), true);
  assert.equal(hasAllCreatorApprovalAssets(complete({ requestKind: "pnl_deal", pnlDealId: null })), false, "both P&L rows must exist");

  assert.equal(hasAllCreatorApprovalAssets(complete({
    requestKind: "leaderboard_only",
    backendDealId: null,
    rewardPayloadPresent: false,
    rewardProgramId: null,
  })), true);
  assert.equal(hasAllCreatorApprovalAssets(complete({ requestKind: "leaderboard_only", leaderboardId: null })), false);

  assert.equal(hasAllCreatorApprovalAssets(complete({
    requestKind: "rewards_only",
    backendDealId: null,
    leaderboardPayloadPresent: false,
    leaderboardId: null,
  })), true);
  assert.equal(hasAllCreatorApprovalAssets(complete({ requestKind: "rewards_only", rewardProgramId: null })), false);
});

test("the current-time guard runs before any provisioning ensure call", async () => {
  const workflow = await readFile("src/lib/creator-deal-approvals.ts", "utf8");
  const start = workflow.indexOf("export async function provisionApprovedCreatorDealRequest");
  const end = workflow.indexOf("export type CreatorDealApprovalResponse", start);
  const provision = workflow.slice(start, end);
  const guard = provision.indexOf("if (windowEnded && !allAssetsAlreadyProvisioned)");

  assert.ok(guard >= 0, "the elapsed-window guard must be present");
  for (const ensureCall of [
    "await ensureBackendDeal(request)",
    "await ensureBackendMultiplierDeal(request)",
    "await ensureAdminPnlDeal(request)",
    "await ensureRewardProgram(withDeal, approvedAt)",
    "await ensureLeaderboard(withDeal)",
  ]) {
    assert.ok(guard < provision.indexOf(ensureCall), `${ensureCall} must run only after the current-time guard`);
  }
  assert.doesNotMatch(
    provision,
    /new Date\(request\.window_end_at\) <= approvedAt/,
    "approval time must never authorize a delayed retry",
  );
});
