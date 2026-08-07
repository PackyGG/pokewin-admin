/**
 * Resilient reads of the additive `admin_users.roles` column.
 *
 * The multi-role feature (migration
 * 20260602000000_add_admin_users_roles_array) adds a `roles admin_role[]`
 * column. Until that migration is applied on a given database, selecting
 * `roles` before the migration throws a PostgreSQL missing-column error.
 * Because `verifySession` runs in the
 * root layout on EVERY request, an unapplied migration would crash the
 * entire admin panel.
 *
 * These helpers make every read of `roles` degrade gracefully: when the
 * column is absent, the read falls back to `roles = []`, which
 * `getEffectiveRoles(role, [])` collapses to the legacy single-role
 * `[role]` behaviour. The app therefore works IDENTICALLY whether or not
 * the migration has run — and once it IS applied, the same code path
 * seamlessly uses the real column with no fallback.
 *
 * Mirrors the existing pre-migration handling for the `preferences`
 * column in src/lib/admin-preferences.ts.
 */

import {
  isPostgresError,
  postgresErrorMessages,
} from "@/lib/postgres-errors";

/**
 * True for PostgreSQL's undefined-column error from an unapplied additive
 * migration. Identical predicate to admin-preferences.ts's helper.
 */
export function isMissingColumnError(err: unknown): boolean {
  return (
    isPostgresError(err, "42703") ||
    /column .* does not exist/i.test(postgresErrorMessages(err))
  );
}

/**
 * Run a read that selects `admin_users.roles`, falling back to a variant
 * that omits `roles` if (and only if) the column does not exist yet.
 *
 * - `withRoles` selects the row INCLUDING `roles`.
 * - `withoutRoles` selects the SAME row WITHOUT `roles`.
 *
 * On the happy path (column present) only `withRoles` runs — one query,
 * no extra round-trip. When the column is missing, `withoutRoles` runs and
 * its result is augmented with `roles: []` so callers get a uniform shape
 * (`getEffectiveRoles` then collapses `[]` to `[role]`).
 *
 * Any error other than a missing-column error is re-thrown unchanged, so
 * real failures (connection issues, etc.) are not masked.
 */
export async function readAdminUserWithRoles<
  TWith,
  TWithout extends object | null,
>(
  withRoles: () => Promise<TWith>,
  withoutRoles: () => Promise<TWithout>,
): Promise<TWith | (NonNullable<TWithout> & { roles: string[] }) | null> {
  try {
    return await withRoles();
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    const row = await withoutRoles();
    // Preserve `null` (row-not-found) verbatim; otherwise inject the
    // empty role set so the effective-role helpers behave as `[role]`.
    if (row === null || row === undefined) return null;
    return { ...(row as NonNullable<TWithout>), roles: [] as string[] };
  }
}

/**
 * Resilient read of the additive per-user override columns
 * `admin_users.permission_grants` / `permission_revokes` (Phase A of the
 * role/permission rebuild — see `ROLE_REDESIGN_DESIGN.md`).
 *
 * These columns do NOT exist yet (they ship in Phase C via
 * owner-gated schema tooling). Until then, selecting them throws a
 * missing-column error. This wrapper —
 * the exact analogue of {@link readAdminUserWithRoles} — runs the
 * override-selecting read on the happy path and, ONLY on a missing-column
 * error, falls back to a read WITHOUT the override columns and augments the
 * result with the empty override `{ grants: [], revokes: [] }`.
 *
 * Effective behavior is therefore IDENTICAL whether or not the columns exist:
 * every user reads as having no overrides (which is also their true state at
 * migration), so a read can run SAFELY before the DB is altered. Once the
 * columns are applied, only `withOverrides` runs — the real values are read
 * with no fallback and no extra round-trip.
 *
 * `withOverrides` selects the row INCLUDING the override columns;
 * `withoutOverrides` selects the SAME row WITHOUT them. Any non-missing-column
 * error is re-thrown unchanged so real failures are not masked. `null`
 * (row-not-found) is preserved verbatim.
 */
export async function readAdminUserWithOverrides<
  TWith,
  TWithout extends object | null,
>(
  withOverrides: () => Promise<TWith>,
  withoutOverrides: () => Promise<TWithout>,
): Promise<
  | TWith
  | (NonNullable<TWithout> & {
      permission_grants: string[];
      permission_revokes: string[];
    })
  | null
> {
  try {
    return await withOverrides();
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    const row = await withoutOverrides();
    // Preserve `null` (row-not-found) verbatim; otherwise inject the empty
    // override so callers get a uniform shape identical to a real row whose
    // columns are still at their `'{}'` defaults.
    if (row === null || row === undefined) return null;
    return {
      ...(row as NonNullable<TWithout>),
      permission_grants: [] as string[],
      permission_revokes: [] as string[],
    };
  }
}

/**
 * Resilient list read for many `admin_users` rows that select `roles`.
 * Same semantics as {@link readAdminUserWithRoles} but for arrays — each
 * fallback row is augmented with `roles: []`.
 */
export async function readAdminUsersWithRoles<
  TWith,
  TWithout extends object,
>(
  withRoles: () => Promise<TWith[]>,
  withoutRoles: () => Promise<TWithout[]>,
): Promise<TWith[] | (TWithout & { roles: string[] })[]> {
  try {
    return await withRoles();
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    const rows = await withoutRoles();
    return rows.map((row) => ({ ...row, roles: [] as string[] }));
  }
}

/** List variant of {@link readAdminUserWithOverrides}. */
export async function readAdminUsersWithOverrides<
  TWith,
  TWithout extends object,
>(
  withOverrides: () => Promise<TWith[]>,
  withoutOverrides: () => Promise<TWithout[]>,
): Promise<
  | TWith[]
  | (TWithout & {
      permission_grants: string[];
      permission_revokes: string[];
    })[]
> {
  try {
    return await withOverrides();
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    const rows = await withoutOverrides();
    return rows.map((row) => ({
      ...row,
      permission_grants: [] as string[],
      permission_revokes: [] as string[],
    }));
  }
}

/**
 * Resilient WRITE for an `admin_users` mutation that sets `roles` (create
 * or update). The read wrappers above degrade reads of the additive
 * `roles` column; this is the symmetric guard for WRITES.
 *
 * Until migration 20260602000000_add_admin_users_roles_array is applied,
 * any write touching `roles` throws SQLSTATE 42703 ("column does not exist"). That
 * means — on an un-migrated DB — every "Edit Roles" action (setAdminRoles)
 * and every new-admin creation (createAdminUser) would throw instead of
 * persisting. This wrapper retries the SAME write with `roles` omitted, so
 * the singular `role` column + `allowed_pages` still persist correctly.
 *
 * Effective behaviour is IDENTICAL whether or not the column exists: with
 * no `roles` column, getEffectiveRoles(role, []) collapses to `[role]`,
 * which is exactly the legacy single-role semantics. Once the migration is
 * applied, only `withRoles` runs and the real column is written — no
 * fallback, no extra round-trip on the happy path.
 *
 * `withRoles` performs the full write (including `roles`); `withoutRoles`
 * performs the SAME write with `roles` removed from the data payload. Any
 * non-missing-column error is re-thrown unchanged so real failures
 * (unique-violation, connection issues) are not masked.
 */
export async function writeAdminUserWithRoles<T>(
  withRoles: () => Promise<T>,
  withoutRoles: () => Promise<T>,
): Promise<T> {
  try {
    return await withRoles();
  } catch (err) {
    if (!isMissingColumnError(err)) throw err;
    return await withoutRoles();
  }
}

/**
 * Process-level memo for {@link adminRolesColumnExists}. Only `true` is
 * cached permanently: once the migration is applied the column never goes
 * away, so re-probing would be wasted work. A `false`/unknown result is
 * NOT cached, so the very next request after the admin SQL migration
 * immediately reflects the new column without a
 * server restart.
 */
let rolesColumnPresent: boolean | null = null;

/**
 * Whether the additive `admin_users.roles` column physically exists on the
 * connected Admin DB. Drives the honest "multi-role needs a migration"
 * notice in the role editor: when this is `false`, assigning MORE THAN ONE
 * role would be silently collapsed to the primary role by
 * {@link writeAdminUserWithRoles}, so the UI must warn instead of pretending
 * it worked.
 *
 * Implemented as a metadata probe against `information_schema.columns` —
 * never selects the column itself, so it can't throw 42703. Any unexpected
 * error degrades to `false` (treat as "not migrated") rather than throwing:
 * a failed probe must never crash the page, and the conservative answer is
 * the one that shows the warning instead of hiding it. The Admin DB client
 * is imported lazily so this module stays importable from the edge/client
 * graph without pulling `pg` in.
 */
export async function adminRolesColumnExists(): Promise<boolean> {
  if (rolesColumnPresent === true) return true;
  try {
    const { adminDrizzle } = await import("@/lib/admin-db");
    const { sql } = await import("drizzle-orm");
    const result = await adminDrizzle.execute<{ exists: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_name = 'admin_users'
           AND column_name = 'roles'
      ) AS exists
    `);
    const present = result.rows[0]?.exists === true;
    if (present) rolesColumnPresent = true;
    return present;
  } catch {
    // Conservative: a failed probe shows the warning (safe) rather than
    // hiding it. Not memoized so a transient failure self-heals next call.
    return false;
  }
}
