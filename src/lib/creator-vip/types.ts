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
  /**
   * MAIN-DB profile of the creator, for the program card.
   *
   * A program is an agreement with a person, and the card is where an
   * operator decides whether to pause or pay one — so it shows who it belongs
   * to, not just a username string. All optional: a failed MAIN lookup leaves
   * the card rendering with initials and no country, never blank.
   */
  creatorImage: string | null;
  creatorCountryCode: string | null;
  creatorIsBanned: boolean;
  /** UPPERCASE codes this program accrues on. */
  codes: string[];
  /** WAGER LEG — both set, or both null when the leg is off. */
  thresholdUsd: number | null;
  rewardUsd: number | null;
  /** Per-unit rate for `vip`-tagged players. null = no uplift. */
  vipRewardUsd: number | null;
  /** LOSSBACK LEG — both set, or both null when the leg is off. */
  lossbackPct: number | null;
  minDepositUsd: number | null;
  isActive: boolean;
  accrualStartAt: string;
  /** Optional scheduled stop. No new offers or claims are allowed at/after it. */
  endsAt: string | null;
  hasEnded: boolean;
  maxRewardPerUserUsd: number | null;
  /**
   * Set when the program was retired but could not be deleted, because its
   * claims are payout history (`creator_reward_claims` is ON DELETE RESTRICT).
   * An archived program is always inactive — a DB CHECK constraint enforces it —
   * so every bot-facing read, which already filters `is_active`, drops it
   * without needing to know archiving exists.
   */
  archivedAt: string | null;
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
/**
 * The two LEGS a program can offer. A program may run either or BOTH, and a
 * player earns each independently — so these name a leg of a program, not a
 * kind of program.
 */
export const CREATOR_REWARD_TYPES = ["wager", "ftd_lossback"] as const;
export type CreatorRewardType = (typeof CREATOR_REWARD_TYPES)[number];

export function isCreatorRewardType(v: unknown): v is CreatorRewardType {
  return (
    typeof v === "string" &&
    (CREATOR_REWARD_TYPES as readonly string[]).includes(v)
  );
}

export type CreatorRewardEntitlement = {
  programId: string;
  programName: string;
  creatorUserId: string;
  /** Which LEG of the program produced this offer. */
  type: CreatorRewardType;
  /**
   * FTD-lossback specifics — the first deposit, what they still hold, and how
   * much of it is lost. Null for wager programs. Every other field below is
   * wager-shaped and reads 0 on a lossback offer.
   */
  ftd: {
    firstDepositUsd: number | null;
    firstDepositAt: string | null;
    hasSecondDeposit: boolean;
    holdingsUsd: number;
    lostUsd: number;
    payoutUsd: number;
    blockedReason: string | null;
  } | null;
  /**
   * Did this player hold the `vip` tag at the moment of THIS check? Re-read
   * live every time — never cached, because the tag can be removed.
   */
  isVip: boolean;
  /** The per-unit rate actually used: the VIP rate if earned, else standard. */
  appliedRewardUsd: number;
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
