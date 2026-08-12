import { REWARD_MAX_VALUE_USD } from "@/lib/user-notification";

export const REWARD_TIER_MAX = 8;

export type DepositWindow =
  | { kind: "lifetime" }
  | { kind: "rolling"; days: number }
  | { kind: "custom"; startDate: string; endDate: string };

export type RewardTier = {
  id: string;
  label: string;
  minDepositUsd: number;
  maxDepositUsd: number | null;
  rewardUsd: number;
  window: DepositWindow;
};

export function roundUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

export function validateRewardTiers(tiers: RewardTier[]): string | null {
  if (tiers.length === 0) return "Add at least one deposit tier";
  if (tiers.length > REWARD_TIER_MAX) {
    return `A campaign can have at most ${REWARD_TIER_MAX} tiers`;
  }

  const ids = new Set<string>();
  for (const [index, tier] of tiers.entries()) {
    const name = tier.label.trim() || `Tier ${index + 1}`;
    if (!/^[a-z0-9_-]{1,40}$/i.test(tier.id) || ids.has(tier.id)) {
      return `${name} has an invalid or duplicate id`;
    }
    ids.add(tier.id);
    if (!Number.isFinite(tier.minDepositUsd) || tier.minDepositUsd < 0) {
      return `${name} needs a valid minimum deposit`;
    }
    if (
      tier.maxDepositUsd !== null &&
      (!Number.isFinite(tier.maxDepositUsd) ||
        tier.maxDepositUsd <= tier.minDepositUsd)
    ) {
      return `${name} maximum deposit must be greater than its minimum`;
    }
    const reward = roundUsd(tier.rewardUsd);
    if (reward <= 0 || reward > REWARD_MAX_VALUE_USD) {
      return `${name} reward must be between $0.01 and $${REWARD_MAX_VALUE_USD}`;
    }
    if (tier.window.kind === "rolling") {
      if (
        !Number.isInteger(tier.window.days) ||
        tier.window.days < 1 ||
        tier.window.days > 3650
      ) {
        return `${name} rolling window must be between 1 and 3650 days`;
      }
    }
    if (tier.window.kind === "custom") {
      const start = Date.parse(`${tier.window.startDate}T00:00:00.000Z`);
      const end = Date.parse(`${tier.window.endDate}T00:00:00.000Z`);
      if (
        !tier.window.startDate ||
        !tier.window.endDate ||
        !Number.isFinite(start) ||
        !Number.isFinite(end)
      ) {
        return `${name} needs valid start and end dates`;
      }
      if (end < start)
        return `${name} end date must be on or after its start date`;
    }
  }
  return null;
}

export function tierMatchesDeposit(
  tier: RewardTier,
  depositedUsd: number,
): boolean {
  return (
    depositedUsd >= roundUsd(tier.minDepositUsd) &&
    (tier.maxDepositUsd === null || depositedUsd < roundUsd(tier.maxDepositUsd))
  );
}

export function depositWindowLabel(window: DepositWindow): string {
  if (window.kind === "lifetime") return "lifetime";
  if (window.kind === "rolling")
    return `last ${window.days} day${window.days === 1 ? "" : "s"}`;
  return `${window.startDate} through ${window.endDate}`;
}
