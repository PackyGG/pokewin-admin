import "server-only";

import { backendApi } from "./client";

/**
 * Withdrawal wager-requirement admin API.
 *
 * The game backend gates every withdrawal behind a lifetime wager
 * requirement, summed across five independently-configurable buckets:
 *
 *   deposit_bps   / 10000 × total_deposited
 * + bonus_bps     / 10000 × total_bonus_won      (rain, prizes, rewards,
 *                                                  sponsored battle share)
 * + affiliate_bps / 10000 × total_affiliate_won  (affiliate commission claims)
 * + rakeback_bps  / 10000 × total_rakeback_won   (rakeback claims)
 * + tips_bps      / 10000 × total_tips_won        (tips received)
 *
 * before any withdrawal is allowed. Every knob is in basis points
 * (10000 bps = 1×). Per-game weights scale how much each wager counts
 * toward the requirement (e.g. upgrader at 8000 bps = 0.8× — a $100
 * upgrader bet adds only $80 of progress).
 *
 * Source of truth (request/response shapes):
 *   packy-backend/src/routes/v1/admin/user-wager-requirements.ts
 *
 * `backendApi`'s base URL already includes `/v1`, so paths are
 * `/admin/...`. Errors surface as BackendApiError (`.status`,
 * `.isNotFound`) / BackendNetworkError — callers degrade gracefully.
 */

/** Site-wide default wager-requirement knobs, all in bps (10000 = 1×). */
export type WagerRequirementDefaults = {
  /** Requirement on lifetime deposits, in bps (10000 = 1×, 0 = disabled). */
  wager_requirement_bps: number;
  /** Requirement on lifetime general bonus winnings (rain, prizes, rewards, sponsored battles), in bps (10000 = 1×, 0 = disabled). */
  bonus_wager_requirement_bps: number;
  /** Requirement on lifetime affiliate commission claims, in bps (10000 = 1×, 0 = disabled). */
  affiliate_wager_requirement_bps: number;
  /** Requirement on lifetime rakeback claims, in bps (10000 = 1×, 0 = disabled). */
  rakeback_wager_requirement_bps: number;
  /** Requirement on lifetime tips received, in bps (10000 = 1×, 0 = disabled). */
  tips_wager_requirement_bps: number;
  /** How much pack wagers count toward the requirement, in bps (10000 = 1×). */
  wager_weight_packs_bps: number;
  /** How much battle wagers count toward the requirement, in bps (10000 = 1×). */
  wager_weight_battles_bps: number;
  /** How much upgrader wagers count toward the requirement, in bps (10000 = 1×). */
  wager_weight_upgrader_bps: number;
};

/**
 * Partial-update payload for the defaults PUT. At least one field must be
 * present — the backend rejects an empty body. Each value is an int in
 * bps, 0..1_000_000.
 */
export type UpdateWagerRequirementDefaultsInput =
  Partial<WagerRequirementDefaults>;

/** Per-user override + the resolved effective value. */
export type UserWagerRequirement = {
  user_id: string;
  /** Per-user override in bps; null = no override (site default applies). 0 = EXEMPT. */
  wager_requirement_bps: number | null;
  /** Current site default in bps. */
  default_wager_requirement_bps: number;
  /** Resolved value the backend enforces (override ?? default). */
  effective_wager_requirement_bps: number;
  created_at: string | null;
  updated_at: string | null;
};

type Success<T> = { success: boolean; data: T };

export const getWagerRequirementDefaults = () =>
  backendApi
    .get<Success<WagerRequirementDefaults>>("/admin/wager-requirement/default")
    .then((r) => r.data);

export const updateWagerRequirementDefaults = (
  input: UpdateWagerRequirementDefaultsInput,
) =>
  backendApi
    .put<Success<WagerRequirementDefaults>>(
      "/admin/wager-requirement/default",
      input,
    )
    .then((r) => r.data);

export const getUserWagerRequirement = (userId: string) =>
  backendApi
    .get<Success<UserWagerRequirement>>(
      `/admin/users/${encodeURIComponent(userId)}/wager-requirement`,
    )
    .then((r) => r.data);

/**
 * Set a per-user override. `bps` is an int ≥ 0; 0 = user fully EXEMPT
 * (the entire requirement, bonus part included).
 */
export const setUserWagerRequirement = (userId: string, bps: number) =>
  backendApi
    .put<Success<UserWagerRequirement>>(
      `/admin/users/${encodeURIComponent(userId)}/wager-requirement`,
      { wager_requirement_bps: bps },
    )
    .then((r) => r.data);

/** Remove a per-user override — user falls back to the site default. */
export const clearUserWagerRequirement = (userId: string) =>
  backendApi.delete<{ success: boolean; message: string }>(
    `/admin/users/${encodeURIComponent(userId)}/wager-requirement`,
  );
