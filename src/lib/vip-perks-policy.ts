export const VIP_PERKS_WINDOW_DAYS = 30;
export const VIP_PERKS_WINDOW_MS = VIP_PERKS_WINDOW_DAYS * 24 * 60 * 60 * 1_000;

export type VipPerksStatus =
  | "pending"
  | "active"
  | "expired"
  | "recurring_due"
  | "inactive";

export type VipPerksPolicyResult = {
  status: VipPerksStatus;
  active: boolean;
  initialDeadline: Date;
  currentCycleStartsAt: Date | null;
  currentCycleEndsAt: Date | null;
  previousCycleStartsAt: Date | null;
  previousCycleEndsAt: Date | null;
};

/**
 * Pure fixed-window policy used by the API, admin roster, and tests.
 *
 * Recurring semantics are intentionally explicit:
 *  - unlocking grants access for the first fixed 30-day cycle;
 *  - at later boundaries, meeting the previous cycle keeps access;
 *  - missing it disables access, but meeting the current cycle immediately
 *    reactivates access (and that same completed cycle carries the next one).
 * Windows never slide and channel edits/re-links never move their anchors.
 */
export function evaluateVipPerksPolicy(input: {
  now: Date;
  enabled: boolean;
  initialThresholdUsd: number;
  recurringEnabled: boolean;
  recurringThresholdUsd: number | null;
  initialWindowStartedAt: Date;
  initialUnlockedAt: Date | null;
  initialWagerUsd: number;
  previousCycleWagerUsd: number;
  currentCycleWagerUsd: number;
}): VipPerksPolicyResult {
  const initialDeadline = new Date(
    input.initialWindowStartedAt.getTime() + VIP_PERKS_WINDOW_MS,
  );
  const inactive = (status: VipPerksStatus): VipPerksPolicyResult => ({
    status,
    active: false,
    initialDeadline,
    currentCycleStartsAt: null,
    currentCycleEndsAt: null,
    previousCycleStartsAt: null,
    previousCycleEndsAt: null,
  });

  if (!input.enabled || input.initialThresholdUsd <= 0) return inactive("inactive");

  if (!input.initialUnlockedAt) {
    if (input.now.getTime() >= initialDeadline.getTime()) return inactive("expired");
    return input.initialWagerUsd >= input.initialThresholdUsd
      ? { ...inactive("active"), active: true }
      : inactive("pending");
  }

  if (!input.recurringEnabled) return { ...inactive("active"), active: true };
  if (!input.recurringThresholdUsd || input.recurringThresholdUsd <= 0) {
    return inactive("inactive");
  }

  const elapsed = Math.max(0, input.now.getTime() - input.initialUnlockedAt.getTime());
  const cycleIndex = Math.floor(elapsed / VIP_PERKS_WINDOW_MS);
  const currentCycleStartsAt = new Date(
    input.initialUnlockedAt.getTime() + cycleIndex * VIP_PERKS_WINDOW_MS,
  );
  const currentCycleEndsAt = new Date(currentCycleStartsAt.getTime() + VIP_PERKS_WINDOW_MS);
  const previousCycleStartsAt =
    cycleIndex === 0
      ? null
      : new Date(currentCycleStartsAt.getTime() - VIP_PERKS_WINDOW_MS);
  const previousCycleEndsAt = cycleIndex === 0 ? null : currentCycleStartsAt;
  const active =
    cycleIndex === 0
    || input.previousCycleWagerUsd >= input.recurringThresholdUsd
    || input.currentCycleWagerUsd >= input.recurringThresholdUsd;

  return {
    status: active ? "active" : "recurring_due",
    active,
    initialDeadline,
    currentCycleStartsAt,
    currentCycleEndsAt,
    previousCycleStartsAt,
    previousCycleEndsAt,
  };
}
