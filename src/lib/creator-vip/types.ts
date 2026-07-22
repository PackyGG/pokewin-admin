/**
 * Shared types for the creator VIP wager-reward system.
 *
 * Client-safe: no DB / `server-only` import, so the tab components can import
 * these directly.
 */

/** Claim lifecycle. Stored as a plain string column (admin-schema convention). */
export const CREATOR_REWARD_CLAIM_STATUSES = [
  "pending",
  "approved",
  "rejected",
] as const;

export type CreatorRewardClaimStatus =
  (typeof CREATOR_REWARD_CLAIM_STATUSES)[number];

export function isCreatorRewardClaimStatus(
  value: unknown,
): value is CreatorRewardClaimStatus {
  return (
    typeof value === "string" &&
    (CREATOR_REWARD_CLAIM_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * The statuses that HOLD wager basis. A pending claim reserves its basis
 * immediately (so a user can't open a second claim against the same wager),
 * and an approved one keeps it forever. A rejected claim holds nothing — it
 * falls out of this filter, which is exactly how rejection releases the basis
 * with no compensating write.
 */
export const BASIS_HOLDING_STATUSES: readonly CreatorRewardClaimStatus[] = [
  "pending",
  "approved",
];

export type CreatorRewardProgram = {
  id: string;
  name: string;
  creatorUserId: string;
  creatorUsername: string | null;
  /** UPPERCASE codes this program accrues on. */
  codes: string[];
  thresholdUsd: number;
  rewardUsd: number;
  isActive: boolean;
  accrualStartAt: string;
  maxRewardPerUserUsd: number | null;
  createdAt: string;
  updatedAt: string;
};

/** Per-program stats for the programs table. */
export type CreatorRewardProgramWithStats = CreatorRewardProgram & {
  pendingClaims: number;
  approvedClaims: number;
  /** Total USD already approved + paid out under this program. */
  paidOutUsd: number;
};

/**
 * What a single user can claim on a single program, right now.
 *
 * Every field is DERIVED — nothing here is stored. Recomputing it from the
 * prod wager rows plus the admin-side consumption ledger always yields the
 * same answer, which is what makes the claim endpoint safe to replay.
 */
export type CreatorRewardEntitlement = {
  programId: string;
  programName: string;
  creatorUserId: string;
  /**
   * Σ SPENDABLE wager — under the program's codes, on the CURRENT run only.
   * Leaving for another creator's code resets this.
   */
  qualifyingWagerUsd: number;
  /**
   * Σ wager under these codes across ALL runs since `accrualStartAt`.
   * AUDIT ONLY — never spendable. Exists so a reset is visible rather than
   * silent.
   */
  lifetimeWagerUsd: number;
  /** lifetimeWagerUsd − qualifyingWagerUsd: cleared by earlier code switches. */
  forfeitedWagerUsd: number;
  /** When the current run began (the last switch away, or the accrual start). */
  runStartedAt: string;
  /** Basis already held by this user's pending + approved claims. */
  priorConsumedUsd: number;
  /** qualifyingWagerUsd − priorConsumedUsd, floored at 0. */
  availableWagerUsd: number;
  /** Completed threshold units available to claim now. */
  units: number;
  /** Payout if claimed now (units × rewardUsd, after any per-user cap). */
  amountUsd: number;
  /** Basis a claim would consume now (units × thresholdUsd). */
  consumesWagerUsd: number;
  /** Wager still needed to reach the NEXT unit. 0 when a unit is ready. */
  wagerToNextUnitUsd: number;
  /** True when the per-user lifetime cap is what's limiting `units`. */
  cappedByUserLimit: boolean;
  /** Set when the user cannot claim right now, with the operator-facing why. */
  blockedReason: string | null;
};
