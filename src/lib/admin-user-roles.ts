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
