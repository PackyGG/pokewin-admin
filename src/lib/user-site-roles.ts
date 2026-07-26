import { ROLES } from "@/lib/constants";
import {
  isPostgresError,
  postgresErrorMessages,
} from "@/lib/postgres-errors";

/**
 * The MAIN-DB `user_role` Postgres enum, mirrored as a string-literal type.
 * Values MUST stay in sync with `userRole` in the checked-in MAIN Drizzle
 * schema and the `ROLES` array in `src/lib/constants.ts`.
 */
export type SiteRole = (typeof ROLES)[number];

const SITE_ROLE_SET: ReadonlySet<string> = new Set(ROLES);

/**
 * Type guard for a recognized MAIN-DB site role (game platform / packy.gg).
 * Mirrors `isAdminRole` in `src/lib/admin-roles.ts`, scoped to the four
 * `user_role` enum members instead of the ADMIN-DB `admin_role` set.
 */
export function isSiteRole(value: string): value is SiteRole {
  return SITE_ROLE_SET.has(value);
}

/**
 * Privilege order used to pick the single "primary" site role for a
 * multi-role user — mirrors `ROLE_PRIORITY` in `src/lib/admin-roles.ts`.
 * `admin` always wins; `user` is the implicit lowest/default. Lower index
 * = higher priority.
 */
const SITE_ROLE_PRIORITY: Record<SiteRole, number> = {
  admin: 0,
  support: 1,
  creator: 2,
  user: 3,
};

/**
 * The effective set of site roles for a game-platform user.
 *
 * Multi-role users carry a non-empty `roles` array; legacy single-role
 * users have an empty/absent `roles` and are represented by the singular
 * `role` column. This normalizes both into one deduped list that ALWAYS
 * contains the primary `role` (so a half-migrated row — non-empty `roles`
 * that somehow omits `role` — can never silently drop the user's base
 * role). Mirrors `getEffectiveRoles` in `src/lib/admin-roles.ts`.
 *
 * Unknown/stale enum strings are filtered out so a bad DB value can't
 * widen access. The result is never empty for a valid user: it falls back
 * to `[role]`, and if even `role` is unrecognized, to `[]`.
 */
export function getEffectiveRoles(
  role: string,
  roles: readonly string[] | null | undefined,
): SiteRole[] {
  const set = new Set<SiteRole>();
  // Primary role first so it's always present in the effective set.
  if (isSiteRole(role)) set.add(role);
  for (const r of roles ?? []) {
    if (isSiteRole(r)) set.add(r);
  }
  return [...set];
}

/**
 * Pick the single canonical/primary role from an effective role set — the
 * highest-privilege member (`admin` first). Used to keep the singular
 * `role` column in sync when roles change. Mirrors `pickPrimaryRole` in
 * `src/lib/admin-roles.ts`; falls back to `"user"` (the implicit
 * lowest/default) when the set is empty or contains no recognized role.
 */
export function pickPrimaryRole(roles: readonly string[]): SiteRole {
  let best: SiteRole | null = null;
  for (const r of roles) {
    if (!isSiteRole(r)) continue;
    if (best === null || SITE_ROLE_PRIORITY[r] < SITE_ROLE_PRIORITY[best]) {
      best = r;
    }
  }
  return best ?? "user";
}

// ---------------------------------------------------------------------------
// Resilient WRITE for the additive MAIN-DB `users.roles` column.
// ---------------------------------------------------------------------------

/**
 * True for the "column does not exist" error that an unapplied additive-
 * column migration produces. Mirrors the identical predicate in
 * `src/lib/admin-user-roles.ts` (`isMissingColumnError`, the same class of
 * problem for `admin_users.roles`) and `src/lib/admin-preferences.ts`.
 * Matches PostgreSQL's `undefined_column` SQLSTATE (`42703`) and defensively
 * checks the nested driver message.
 */
export function isMissingRolesColumnError(err: unknown): boolean {
  return (
    isPostgresError(err, "42703") ||
    /column .* does not exist/i.test(postgresErrorMessages(err))
  );
}

/**
 * Resilient WRITE for a MAIN-DB `users` mutation that sets the additive
 * `roles` column (multi-role Site Role support).
 *
 * The owner applies `ALTER TABLE users ADD COLUMN IF NOT EXISTS roles
 * user_role[] NOT NULL DEFAULT '{}'` against the read-only, owner-managed
 * MAIN DB on their own timeline — this workflow does not control when.
 * Until that lands, any write that touches `roles` throws a missing-column
 * error. This wrapper retries the SAME write with `roles` omitted, so the
 * canonical `role` column still persists instead of the whole action
 * throwing. Mirrors `writeAdminUserWithRoles` in
 * `src/lib/admin-user-roles.ts` exactly, for the MAIN-DB `users` table
 * instead of the ADMIN-DB `admin_users` table.
 *
 * `withRoles` performs the full write (including `roles`); `withoutRoles`
 * performs the SAME write with `roles` removed from the data payload. Any
 * non-missing-column error is re-thrown unchanged so real failures
 * (unique-violation, connection issues) are not masked.
 *
 * Returns `{ result, rolesColumnExists }` so the caller can surface an
 * honest notice when the fallback path ran instead of silently pretending
 * the multi-role write succeeded.
 */
export async function writeUserWithRoles<T>(
  withRoles: () => Promise<T>,
  withoutRoles: () => Promise<T>,
): Promise<{ result: T; rolesColumnExists: boolean }> {
  try {
    const result = await withRoles();
    return { result, rolesColumnExists: true };
  } catch (err) {
    if (!isMissingRolesColumnError(err)) throw err;
    const result = await withoutRoles();
    return { result, rolesColumnExists: false };
  }
}
