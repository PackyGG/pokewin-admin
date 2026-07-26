// =============================================================================
// role-limits-merge.ts — PURE per-ROLE balance-limit math (RoleV2 P3).
//
// Zero runtime database dependencies so it loads under a
// plain `tsx --test` / `node:test` context. The DB-backed resolvers + the
// server action live in `role-limits.ts` / `role-limits-actions.ts` and import
// from HERE, so the enforcement path and the unit test exercise the exact same
// functions (no replica that could drift).
// =============================================================================

/** Resolved per-role balance-limit defaults for one admin, per period. A
 *  `null` slot = "no role-level cap for this period" → caller falls through to
 *  the next layer (per-user row, else unlimited). */
export type RoleBalanceLimitDefaults = {
  daily: number | null;
  weekly: number | null;
  monthly: number | null;
};

/** The all-null role defaults (every role's state today). */
export const EMPTY_ROLE_BALANCE_LIMIT_DEFAULTS: RoleBalanceLimitDefaults = {
  daily: null,
  weekly: null,
  monthly: null,
};

/**
 * The three balance-limit period slots a single `admin_roles` row contributes.
 * Numeric columns arrive as decimal-compatible values; the DB resolver
 * coerces to `number | null` via `Number(...)` (mirrors
 * `checkBalanceAdjustmentLimit`'s existing `Number(limit.max_amount)`
 * coercion). A `Decimal(12,2)` value is always within JS safe-integer range
 * for currency, so this is lossless.
 */
export type RoleBalanceLimitRow = {
  daily: number | null;
  weekly: number | null;
  monthly: number | null;
};

/**
 * PURE merge: collapse many roles' balance-limit slots into the single
 * most-restrictive (smallest) non-null value per period. Multi-role ⇒ the
 * tightest cap wins. A period with no non-null contributor stays `null`
 * (no role-level cap).
 */
export function mergeRoleBalanceLimits(
  rows: readonly RoleBalanceLimitRow[],
): RoleBalanceLimitDefaults {
  const out: RoleBalanceLimitDefaults = { daily: null, weekly: null, monthly: null };
  const periods = ["daily", "weekly", "monthly"] as const;
  for (const row of rows) {
    for (const p of periods) {
      const v = row[p];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      // Smallest (most-restrictive) non-null value wins.
      if (out[p] === null || v < out[p]!) out[p] = v;
    }
  }
  return out;
}

/**
 * PURE per-period cap resolution: the per-user row WINS over the role default,
 * which wins over "unlimited". Exactly `userMax ?? roleDefault ?? null` — a
 * present per-user cap (incl. one that is larger OR smaller than the role
 * default) takes precedence; with no per-user cap the role default applies;
 * with neither the period is uncapped (`null`). This is the merge rule
 * `checkBalanceAdjustmentLimit` applies per period.
 */
export function resolveEffectiveCap(
  userMax: number | null | undefined,
  roleDefault: number | null | undefined,
): number | null {
  return userMax ?? roleDefault ?? null;
}
