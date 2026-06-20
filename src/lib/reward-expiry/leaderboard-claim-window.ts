/**
 * Affiliate / creator leaderboard prize claim-window math — days after the
 * leaderboard's `end_date` that prizes stay claimable
 * (`reward_expiry_leaderboard_days` / backend `leaderboard_days`). 0 = never
 * expires. Enforced at claim time on the game backend
 * (`affiliate-leaderboard.service.ts claimPrize`, anchor `end_date`); this
 * module is for admin / creator-hub display only.
 */

const MS_PER_DAY = 86_400_000;

export type LeaderboardClaimWindowStatus =
  | "unavailable"
  | "never_expires"
  | "period_active"
  | "claimable"
  | "expired";

export type LeaderboardClaimWindow = {
  status: LeaderboardClaimWindowStatus;
  /** When the leaderboard ends (or ended). */
  endIso: string | null;
  /** Last instant prizes can be claimed (end + leaderboard_days). */
  claimExpiresAtIso: string | null;
  expiryDays: number | null;
  /** Milliseconds until claim window closes; only set when claimable. */
  msUntilClaimExpires: number | null;
  /** Milliseconds until the leaderboard ends; only set when still running. */
  msUntilPeriodEnd: number | null;
};

export function computeLeaderboardClaimWindow(params: {
  endIso: string | null;
  expiryDays: number | null;
  now?: Date;
}): LeaderboardClaimWindow {
  const now = params.now ?? new Date();
  const base = {
    endIso: params.endIso,
    claimExpiresAtIso: null as string | null,
    expiryDays: params.expiryDays,
    msUntilClaimExpires: null as number | null,
    msUntilPeriodEnd: null as number | null,
  };

  if (params.expiryDays === null) {
    return { ...base, status: "unavailable" };
  }

  if (params.expiryDays === 0) {
    return { ...base, status: "never_expires" };
  }

  if (!params.endIso) {
    return { ...base, status: "period_active" };
  }

  const endMs = new Date(params.endIso).getTime();
  if (!Number.isFinite(endMs)) {
    return { ...base, status: "period_active" };
  }

  if (endMs > now.getTime()) {
    return {
      ...base,
      status: "period_active",
      msUntilPeriodEnd: endMs - now.getTime(),
    };
  }

  const claimExpiresMs = endMs + params.expiryDays * MS_PER_DAY;
  const claimExpiresAtIso = new Date(claimExpiresMs).toISOString();
  const msUntilClaimExpires = claimExpiresMs - now.getTime();

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
