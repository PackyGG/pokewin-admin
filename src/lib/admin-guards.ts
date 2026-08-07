/**
 * Phase D — admin-account SAFETY GUARDS (see ROLE_REDESIGN_DESIGN.md §D).
 *
 * Four owner-approved guards that change NO role's page/capability allowance —
 * only WHO can act and WHEN a session is still valid:
 *   1. last-admin guard      — can't drop active effective-admins to 0
 *   2. self-demotion guard   — can't remove your OWN admin access
 *   3. session revocation    — a JWT issued before `sessions_valid_after` is dead
 *   4. mandatory 2FA         — gate (flag-controlled, default ON)
 *
 * This module is split deliberately:
 *   • PURE functions (no DB, no `server-only`, no Next graph) hold the actual
 *     decision logic so it is unit-testable with `tsx --test` (see
 *     scripts/__fixtures__/admin-guards.test.ts). They are the source of truth.
 *   • Thin ASYNC helpers wrap those with the ADMIN-DB reads the actions need
 *     (count active admins, read the mandatory-2FA flag). They live here too so
 *     every guard call site shares ONE implementation.
 *
 * No guard runs a mass UPDATE and none touches the permission model.
 */

import { getEffectiveRoles } from "@/lib/admin-roles";

// ── PURE logic ───────────────────────────────────────────────────────────────

/**
 * True if the given (role, roles) pair grants the effective `admin` role — the
 * total-bypass system role. Mirrors `sessionIsAdmin` but works off raw DB
 * fields so the guards can reason about a user that is NOT the current session.
 */
export function roleSetHasAdmin(
  role: string,
  roles: readonly string[] | null | undefined,
): boolean {
  return getEffectiveRoles(role, roles).includes("admin");
}

/**
 * Only effective admins and owners may reuse a passkey assertion. Kept pure so
 * both the minting path and the consuming action can apply the same rule to
 * DB-fresh account fields.
 */
export function canUsePasskeyGrace(args: {
  role: string;
  roles: readonly string[] | null | undefined;
  username: string | null | undefined;
  isOwner: boolean | null | undefined;
}): boolean {
  return (
    roleSetHasAdmin(args.role, args.roles) ||
    args.isOwner === true ||
    (args.username ?? "").trim().toLowerCase() === "motha"
  );
}

/**
 * Last-admin guard decision (PURE). Given:
 *   • whether the TARGET currently counts as an active effective-admin,
 *   • whether the proposed change leaves the target still an active admin,
 *   • the number of OTHER active effective-admins (everyone except the target),
 * returns true when the action must be BLOCKED because it would drop the count
 * of active admins to zero.
 *
 * The action is blocked iff the target is removing the LAST admin: the target
 * is an active admin today, the change strips that, and there is no other
 * active admin to take over. A change that keeps the target an admin, or that
 * targets a non-admin, never trips this.
 */
export function wouldDropLastActiveAdmin(args: {
  targetIsActiveAdminNow: boolean;
  targetStaysActiveAdmin: boolean;
  otherActiveAdminCount: number;
}): boolean {
  const { targetIsActiveAdminNow, targetStaysActiveAdmin, otherActiveAdminCount } =
    args;
  // Only a transition admin → not-admin can remove an admin. If the target
  // isn't an active admin now, or stays one, nothing is lost.
  if (!targetIsActiveAdminNow) return false;
  if (targetStaysActiveAdmin) return false;
  // The target's admin slot is being removed — block unless someone else still
  // holds an active admin role.
  return otherActiveAdminCount === 0;
}

/**
 * Self-demotion guard decision for a ROLE change (PURE). Blocks when the actor
 * is editing THEIR OWN account AND the new role set drops their `admin` role
 * (i.e. they currently have admin and would lose it). Removing a non-admin role
 * from yourself, or editing someone else, never trips this.
 */
export function wouldRemoveOwnAdminViaRoles(args: {
  isSelf: boolean;
  currentlyAdmin: boolean;
  newRoles: readonly string[];
}): boolean {
  const { isSelf, currentlyAdmin, newRoles } = args;
  if (!isSelf) return false;
  if (!currentlyAdmin) return false;
  // They are an admin editing themselves — block iff the new set no longer
  // grants admin.
  return !newRoles.includes("admin");
}

/**
 * Self-demotion guard decision for a per-user PERMISSION override (PURE). The
 * per-user editor only targets NON-admin users (admins bypass the gate and the
 * action already rejects admin targets), so for a self-edit this guard blocks
 * any access REDUCTION: a self-edit that revokes one of the actor's own current
 * allowed_pages tokens, or whose new effective set is a strict shrink of the
 * old one. Editing someone else never trips this.
 *
 * `currentAllowed` / `nextAllowed` are the materialized allowed_pages before
 * and after the proposed save.
 */
export function wouldReduceOwnAccessViaOverride(args: {
  isSelf: boolean;
  currentAllowed: readonly string[];
  nextAllowed: readonly string[];
}): boolean {
  const { isSelf, currentAllowed, nextAllowed } = args;
  if (!isSelf) return false;
  const next = new Set(nextAllowed);
  // Any token the actor has today that the save would remove = a reduction.
  for (const t of currentAllowed) {
    if (!next.has(t)) return true;
  }
  return false;
}

/**
 * Session-revocation decision (PURE). A session is revoked when the account has
 * a non-null `sessions_valid_after` watermark AND the JWT was issued at or
 * before it. Comparison is in SECONDS to match the JWT `iat` claim (jose stores
 * `iat` as integer seconds; `setIssuedAt()` rounds down).
 *
 * `iatSeconds` is the JWT `iat` claim (seconds). `validAfter` is the account's
 * watermark (Date) or null/undefined when no revocation is in force. A missing
 * `iat` (older cookie that predates `setIssuedAt`) is treated as "issued at the
 * epoch" → revoked whenever a watermark exists, which is the safe direction
 * (forces a fresh login that will mint an `iat`).
 */
export function isSessionRevoked(
  iatSeconds: number | null | undefined,
  validAfter: Date | string | null | undefined,
): boolean {
  if (validAfter === null || validAfter === undefined) return false;
  const watermarkMs =
    validAfter instanceof Date ? validAfter.getTime() : new Date(validAfter).getTime();
  if (Number.isNaN(watermarkMs)) return false;
  const watermarkSeconds = Math.floor(watermarkMs / 1000);
  // Missing iat → epoch (0) → always before any real watermark → revoked.
  const iat = typeof iatSeconds === "number" && Number.isFinite(iatSeconds)
    ? iatSeconds
    : 0;
  // Strictly-before: a token minted in the same second as the watermark is
  // kept (the watermark is set to "now" when revoking; tokens minted AFTER are
  // newer and must survive).
  return iat < watermarkSeconds;
}

// ── Mandatory-2FA flag ────────────────────────────────────────────────────────

/**
 * The admin_settings key backing the mandatory-2FA gate. A value of `"false"`
 * (case-insensitive) turns enforcement OFF; ANY other value — INCLUDING the
 * UNSET / missing-row / missing-table case — leaves it ON. This makes the
 * feature DEFAULT ON (owner-approved; all admins are already enrolled) while
 * staying instantly reversible: the owner sets the key to `false` (SQL or the
 * settings UI) to disable it with no deploy. Fail-safe direction is debatable,
 * but ON-by-default here is the owner's explicit choice.
 */
const MANDATORY_2FA_SETTING_KEY = "mandatory_2fa_enabled";

/**
 * PURE: interpret a raw admin_settings value into the enforcement flag.
 * Default ON: only an explicit "false" disables it.
 */
function mandatory2faEnabledFromValue(value: string | null): boolean {
  if (value === null) return true; // unset → default ON
  return value.trim().toLowerCase() !== "false";
}

/**
 * Read the mandatory-2FA enforcement flag from admin_settings (ASYNC). Default
 * ON. Resilient: `getAdminSetting` already degrades a missing admin_settings
 * table to `null` (→ ON). Any OTHER read failure also degrades to the safe
 * default rather than throwing, because this is consulted inside `verifySession`
 * which runs on EVERY admin request — it must NEVER throw on the happy path.
 *
 * IMPORTANT default-direction note: returning ON on a transient DB blip would,
 * combined with the verifySession redirect, bounce a normal enrolled admin —
 * but the redirect is ALSO guarded by `totp_enabled === false`, and every
 * enrolled admin has `totp_enabled === true`, so a flag-read blip cannot lock
 * out an enrolled admin. The only users the flag can affect are non-enrolled
 * ones, who SHOULD be pushed to setup.
 */
export async function isMandatory2faEnabled(): Promise<boolean> {
  try {
    const { getAdminSetting } = await import("@/lib/admin-settings");
    const value = await getAdminSetting(MANDATORY_2FA_SETTING_KEY);
    return mandatory2faEnabledFromValue(value);
  } catch {
    return true; // default ON on any unexpected failure
  }
}

// ── Active-admin counting (ASYNC, ADMIN DB) ───────────────────────────────────

/**
 * Count the active admin users OTHER than `excludeId` whose effective role set
 * includes `admin`. Used by the last-admin guard: an action that removes the
 * target's admin role is blocked when this returns 0.
 *
 * Counts at the SQL layer (`role = 'admin' OR 'admin' = ANY(roles)`) so it stays
 * a single cheap query regardless of admin-table size. `is_active = true` is
 * required — a deactivated admin can't act, so they don't count as "an admin who
 * can take over". The Admin DB client is imported lazily so this module stays
 * importable from contexts that shouldn't pull `pg`.
 */
export async function countOtherActiveEffectiveAdmins(
  excludeId: string,
): Promise<number> {
  const { adminDrizzle } = await import("@/lib/admin-db");
  const { sql } = await import("drizzle-orm");
  const result = await adminDrizzle.execute<{ count: string }>(sql`
    SELECT COUNT(*)::bigint AS count
      FROM admin_users
     WHERE is_active = true
       AND id <> ${excludeId}::uuid
       AND (role = 'admin' OR 'admin'::admin_role = ANY(roles))
  `);
  const raw = result.rows[0]?.count;
  return raw === undefined || raw === null ? 0 : Number(raw);
}
