import "server-only";

import { backendApi } from "./client";

/**
 * Withdrawal wager-requirement admin API (site defaults + per-user override).
 *
 * The game backend gates withdrawals behind a wager requirement configured by
 * five independent bps knobs (10000 bps = 1×), one per credit source:
 *
 *   deposit_bps   — on deposits
 *   bonus_bps     — on general bonus winnings (rain, prizes, rewards,
 *                   sponsored battle share)
 *   affiliate_bps — on affiliate commission claims
 *   rakeback_bps  — on rakeback claims
 *   tips_bps      — on tips received
 *
 * ENFORCEMENT MODEL (backend rework 2026-06-14, commit 74b8042c / migration
 * 0130): these bps are NO LONGER a live cumulative "Σ(lifetime total × bps) vs
 * progress" gate. Each deposit/bonus credit now FREEZES `amount × its_bps /
 * 10000` into a per-balance debt counter `balances.wager_requirement_remaining`
 * at credit time (later edits to these knobs only affect FUTURE credits); every
 * real weighted wager burns that debt down. Withdrawal is a PARTIAL lock:
 * withdrawable = max(0, available − remaining). So editing a knob here changes
 * what newly-credited funds will owe — it does NOT retroactively re-price debt
 * already frozen. Per-game weights still scale how much a wager counts (e.g.
 * upgrader at 8000 bps = 0.8×).
 *
 * NOTE (commit 85c23fe0): early-claimed rakeback is now bucketed as `rakeback`
 * bonus funds, so it accrues this requirement and lands in `total_rakeback_won`
 * / `unwagered_rakeback_usd` like a normal claim — balance-derived rakeback
 * liability (per-user wager card + /insights/wager-liability) will rise from
 * that deploy onward. The rakeback INSIGHTS surface (reads `rakeback_claims`)
 * is unaffected.
 *
 * Source of truth (request/response shapes):
 *   PackyGG/backend/src/routes/v1/admin/user-wager-requirements.ts
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
  /** Requirement on affiliate leaderboard prize claims, in bps (10000 = 1×, 0 = disabled). */
  affiliate_leaderboard_wager_requirement_bps: number;
  /** Requirement on lifetime rakeback claims, in bps (10000 = 1×, 0 = disabled). */
  rakeback_wager_requirement_bps: number;
  /** Requirement on lifetime tips received, in bps (10000 = 1×, 0 = disabled). */
  tips_wager_requirement_bps: number;
  /**
   * Requirement FROZEN onto each admin balance-adjustment CREDIT, in bps of
   * the credited amount (10000 = 1×, 0 = disabled). Applied by the admin
   * panel's adjustBalance writer (freezes `amount × bps / 10000` into
   * `balances.wager_requirement_remaining`), so a giveaway/bonus credit can't
   * be instantly withdrawn. Per-credit, not lifetime.
   */
  admin_adjustment_wager_requirement_bps: number;
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
  /** Per-user deposit override in bps; null = no override (site default applies). 0 = EXEMPT. */
  wager_requirement_bps: number | null;
  /** Per-user bonus/leaderboard override in bps; null = uses global default. */
  bonus_wager_requirement_bps: number | null;
  /** Per-user affiliate claims override in bps; null = uses global default. */
  affiliate_wager_requirement_bps: number | null;
  /** Per-user affiliate leaderboard prize override in bps; null = uses global default. */
  affiliate_leaderboard_wager_requirement_bps: number | null;
  /** Per-user rakeback claims override in bps; null = uses global default. */
  rakeback_wager_requirement_bps: number | null;
  /** Per-user tips received override in bps; null = uses global default. */
  tips_wager_requirement_bps: number | null;
  /** Per-user admin adjustment override in bps; null = uses global default. */
  admin_adjustment_wager_requirement_bps: number | null;
  /** Current site default in bps (deposit source). */
  default_wager_requirement_bps: number;
  /** Resolved value the backend enforces for deposits (override ?? default). */
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
 * Set per-user overrides for one or more wager-requirement sources.
 * Pass only the fields you want to change. null clears an override (falls
 * back to site global). 0 = fully exempt for that source. 10000 = 1×.
 */
export async function setUserWagerRequirement(
  userId: string,
  params: {
    wager_requirement_bps?: number;
    bonus_wager_requirement_bps?: number | null;
    affiliate_wager_requirement_bps?: number | null;
    affiliate_leaderboard_wager_requirement_bps?: number | null;
    rakeback_wager_requirement_bps?: number | null;
    tips_wager_requirement_bps?: number | null;
    admin_adjustment_wager_requirement_bps?: number | null;
  },
): Promise<UserWagerRequirement> {
  const res = await backendApi.put<Success<UserWagerRequirement>>(
    `/admin/users/${encodeURIComponent(userId)}/wager-requirement`,
    params,
  );
  return res.data;
}

/** Remove a per-user override — user falls back to the site default. */
export const clearUserWagerRequirement = (userId: string) =>
  backendApi.delete<{ success: boolean; message: string }>(
    `/admin/users/${encodeURIComponent(userId)}/wager-requirement`,
  );

/**
 * Directly set the user's `balances.wager_requirement_remaining` (the frozen
 * debt counter). `amountUsd` is a Decimal string — "0" clears the debt
 * entirely so the user can withdraw immediately.
 *
 * Endpoint: PUT /admin/users/:userId/wager-requirement-remaining
 * Body: { amount_usd: string }
 */
export async function setUserWagerRemainingDebt(
  userId: string,
  amountUsd: string,
): Promise<{ user_id: string; old_remaining_usd: string; new_remaining_usd: string }> {
  const res = await backendApi.put<{
    success: boolean;
    data: { user_id: string; old_remaining_usd: string; new_remaining_usd: string };
  }>(
    `/admin/users/${encodeURIComponent(userId)}/wager-requirement-remaining`,
    { amount_usd: amountUsd },
  );
  return res.data;
}
