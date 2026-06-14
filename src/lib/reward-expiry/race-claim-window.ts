/**
 * Race prize claim-window math — days after the race period ENDS that prizes
 * stay claimable (`reward_expiry_race_days` / backend `race_days`). 0 = never
 * expires. Enforced at claim time on the game backend; this module is for
 * admin display only.
 */

const MS_PER_DAY = 86_400_000;

export type RaceClaimWindowStatus =
  | "unavailable"
  | "never_expires"
  | "period_active"
  | "frozen"
  | "claimable"
  | "expired";

export type RaceClaimWindow = {
  status: RaceClaimWindowStatus;
  /** When the race period ended (or is scheduled to end if still running). */
  periodEndIso: string | null;
  /** Last instant prizes can be claimed (period end + race_days). */
  claimExpiresAtIso: string | null;
  raceExpiryDays: number | null;
  claimsFrozen: boolean;
  /** Milliseconds until claim window closes; only set when claimable. */
  msUntilClaimExpires: number | null;
  /** Milliseconds until the period ends; only set when period still running. */
  msUntilPeriodEnd: number | null;
};

export function computeRaceClaimWindow(params: {
  periodEndIso: string | null;
  raceExpiryDays: number | null;
  claimsFrozen?: boolean;
  now?: Date;
}): RaceClaimWindow {
  const now = params.now ?? new Date();
  const claimsFrozen = params.claimsFrozen ?? false;
  const base = {
    periodEndIso: params.periodEndIso,
    claimExpiresAtIso: null as string | null,
    raceExpiryDays: params.raceExpiryDays,
    claimsFrozen,
    msUntilClaimExpires: null as number | null,
    msUntilPeriodEnd: null as number | null,
  };

  if (params.raceExpiryDays === null) {
    return { ...base, status: "unavailable" };
  }

  if (params.raceExpiryDays === 0) {
    return { ...base, status: "never_expires" };
  }

  if (!params.periodEndIso) {
    return { ...base, status: "period_active" };
  }

  const periodEndMs = new Date(params.periodEndIso).getTime();
  if (!Number.isFinite(periodEndMs)) {
    return { ...base, status: "period_active" };
  }

  if (periodEndMs > now.getTime()) {
    return {
      ...base,
      status: "period_active",
      msUntilPeriodEnd: periodEndMs - now.getTime(),
    };
  }

  const claimExpiresMs =
    periodEndMs + params.raceExpiryDays * MS_PER_DAY;
  const claimExpiresAtIso = new Date(claimExpiresMs).toISOString();
  const msUntilClaimExpires = claimExpiresMs - now.getTime();

  if (claimsFrozen) {
    return {
      ...base,
      status: "frozen",
      claimExpiresAtIso,
      msUntilClaimExpires: Math.max(0, msUntilClaimExpires),
    };
  }

  if (msUntilClaimExpires <= 0) {
    return {
      ...base,
      status: "expired",
      claimExpiresAtIso,
      msUntilClaimExpires: 0,
    };
  }

  return {
    ...base,
    status: "claimable",
    claimExpiresAtIso,
    msUntilClaimExpires,
  };
}

export function isRacePrizeClaimExpired(
  window: RaceClaimWindow,
  claimedAt: string | null,
): boolean {
  if (claimedAt) return false;
  return window.status === "expired";
}
