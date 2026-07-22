import "server-only";

import { backendApi } from "./client";

/**
 * Affiliate deposit-bonus cap config admin API.
 *
 * The bonus itself is a fixed 5% of each deposit; these two knobs bound how
 * much of it a referred user can collect: at most `cap_per_period_usd` within
 * any trailing `period_hours` rolling window. Capping this way reproduces ≈ the
 * legacy $100/24h ceiling but spreads it across the day, so a single large
 * deposit can no longer claim the full daily allowance at once.
 *
 * LIVE VALUES ≠ the defaults below (verified read-only on prod 2026-07-22):
 * `deposit_bonus_cap_per_period_usd` is set to **20**, and
 * `deposit_bonus_period_hours` has never been written to site_config at all —
 * so the window runs on the backend default. The cap binds hard: over the 14d
 * to 2026-07-22, $590.49 of bonus on $21,748 of deposits = an effective 2.7%,
 * not the nominal 5%. Read the live key before quoting a cap anywhere.
 *
 * Changes apply to deposits from now on — bonuses already credited are never
 * re-touched.
 *
 * Source of truth (request/response shapes):
 *   packygg-backend/src/routes/v1/admin/deposit-bonus-config.ts
 *
 * `backendApi`'s base URL already includes `/v1`, so paths are
 * `/admin/...`. Errors surface as BackendApiError / BackendNetworkError —
 * callers degrade gracefully.
 */

/** Deposit-bonus cap config: rolling window length + max bonus per window. */
export type DepositBonusConfig = {
  /** Length of the rolling cap window, in hours (default 6). */
  period_hours: number;
  /** Max bonus USD a user can earn within one window (default 25). */
  cap_per_period_usd: number;
};

/**
 * PUT payload — both fields optional (partial update), but the backend
 * requires at least one. `period_hours` > 0 and ≤ 720; `cap_per_period_usd`
 * ≥ 0 and ≤ 100000.
 */
export type UpdateDepositBonusConfigInput = {
  period_hours?: number;
  cap_per_period_usd?: number;
};

type Success<T> = { success: boolean; data: T };

export const getDepositBonusConfig = () =>
  backendApi
    .get<Success<DepositBonusConfig>>("/admin/deposit-bonus-config")
    .then((r) => r.data);

export const updateDepositBonusConfig = (
  input: UpdateDepositBonusConfigInput,
) =>
  backendApi
    .put<Success<DepositBonusConfig>>("/admin/deposit-bonus-config", input)
    .then((r) => r.data);
