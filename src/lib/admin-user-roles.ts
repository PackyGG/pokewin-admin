/**
 * Resilient reads of the additive `admin_users.roles` column.
 *
 * The multi-role feature (migration
 * 20260602000000_add_admin_users_roles_array) adds a `roles admin_role[]`
 * column. Until that migration is applied on a given database, selecting
 * `roles` through the typed Prisma client throws a P2022
 * ("column does not exist") error. Because `verifySession` runs in the
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
 * column in src/lib/admin-preferences.ts (same P2022 detection).
 */

/**
 * True for the Prisma "column does not exist" error (P2022) that an
 * unapplied additive-column migration produces. Also matches the raw
 * Postgres message defensively, since the adapter/raw paths can surface
 * the error slightly differently. Identical predicate to
 * admin-preferences.ts's `isMissingColumnError`.
 */
export function isMissingColumnError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: string }).code;
  if (code === "P2022") return true;
  return /column .* does not exist/i.test(err.message);
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

/**
 * Resilient WRITE for an `admin_users` mutation that sets `roles` (create
 * or update). The read wrappers above degrade reads of the additive
 * `roles` column; this is the symmetric guard for WRITES.
 *
 * Until migration 20260602000000_add_admin_users_roles_array is applied,
 * any write touching `roles` throws P2022 ("column does not exist"). That
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
 * NOT cached, so the very next request after the owner runs
 * `npm run admin:migrate` immediately reflects the new column without a
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
 * never selects the column itself, so it can't throw P2022. Any unexpected
 * error degrades to `false` (treat as "not migrated") rather than throwing:
 * a failed probe must never crash the page, and the conservative answer is
 * the one that shows the warning instead of hiding it. The Admin DB client
 * is imported lazily so this module stays importable from the edge/client
 * graph without pulling `pg` in.
 */
export async function adminRolesColumnExists(): Promise<boolean> {
  if (rolesColumnPresent === true) return true;
  try {
    const { adminDb } = await import("@/lib/admin-db");
    const rows = await adminDb.$queryRaw<{ exists: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
          FROM information_schema.columns
         WHERE table_name = 'admin_users'
           AND column_name = 'roles'
      ) AS exists
    `;
    const present = rows[0]?.exists === true;
    if (present) rolesColumnPresent = true;
    return present;
  } catch {
    // Conservative: a failed probe shows the warning (safe) rather than
    // hiding it. Not memoized so a transient failure self-heals next call.
    return false;
  }
}
