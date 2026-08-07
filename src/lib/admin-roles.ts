/**
 * Every built-in system role, in highest → lowest privilege order.
 *
 * SINGLE SOURCE OF TRUTH for the built-in role spellings: the `AdminRole`
 * union and {@link PERSISTABLE_ADMIN_ROLES} are DERIVED from this list, so
 * the spellings can never drift apart (they used to be three hand-kept
 * copies).
 */
export const ALL_ADMIN_ROLES = [
  "admin",
  "support",
  "marketing",
  "creator",
  "pack_creator",
  // Creator Hub manager — the in-house Creator-Marketing (CM) team role.
  // Lands on /creator-hub when it is the primary role. Hub entry is gated
  // via `canAccessCreatorHub` (founder motha OR per-role ADMIN-DB toggle).
  "creator_manager",
] as const;

export type AdminRole = (typeof ALL_ADMIN_ROLES)[number];

/**
 * The subset of built-in roles that exist as values in the ADMIN-DB
 * `admin_role` Postgres enum and can therefore be PERSISTED on an
 * `admin_users` row. Today EVERY built-in role is in the enum, so this is
 * derived directly from {@link ALL_ADMIN_ROLES}. If a code-only role ever
 * ships ahead of its additive enum migration, exclude it here explicitly
 * (and apply the reviewed Admin SQL to extend the enum before removing the
 * exclusion).
 *
 * Any code path that builds a value to store in `admin_users.role` /
 * `admin_users.roles` (e.g. the create / set-roles admin actions) must
 * filter candidate roles through {@link isPersistableAdminRole} so a
 * code-only role never reaches the database. Pure in-memory role checks
 * (sidebar gating, `requireRole`, landing routes) use the full
 * `ALL_ADMIN_ROLES` / `isAdminRole` set and are unaffected.
 */
export const PERSISTABLE_ADMIN_ROLES: readonly AdminRole[] = ALL_ADMIN_ROLES;

const PERSISTABLE_ADMIN_ROLE_SET: ReadonlySet<string> = new Set(
  PERSISTABLE_ADMIN_ROLES,
);

/**
 * Type guard for a built-in role that can be stored in the ADMIN-DB
 * `admin_role` enum. `AdminRole` is exactly the database-enum string set
 * (both are derived from {@link ALL_ADMIN_ROLES}), so the narrowed result
 * is assignable to an `admin_role`-typed field. Drops unknown strings.
 */
export function isPersistableAdminRole(value: string): value is AdminRole {
  return PERSISTABLE_ADMIN_ROLE_SET.has(value);
}

const ADMIN_ROLE_SET: ReadonlySet<string> = new Set(ALL_ADMIN_ROLES);

/** Type guard for a recognized built-in system role. */
export function isAdminRole(value: string): value is AdminRole {
  return ADMIN_ROLE_SET.has(value);
}

// Privilege ordering used to pick the single "primary" role for a
// multi-role user. `admin` ALWAYS wins (it bypasses every page /
// capability gate); the rest follow the historical landing-priority so a
// support+pack_creator user lands on the support surface (/users) rather
// than /packs, which matches "do their main job first". Lower index =
// higher priority.
const ROLE_PRIORITY: Record<AdminRole, number> = {
  admin: 0,
  support: 1,
  marketing: 2,
  // The Creator-Hub manager sits just above the plain creator/pack_creator
  // self-service roles in landing priority: a support+creator_manager user
  // still lands on the support surface, but a creator_manager (without
  // support/marketing) lands on the Creator Hub rather than a creator
  // self-service page (see getDefaultRoute below).
  creator_manager: 3,
  creator: 4,
  pack_creator: 5,
};

/**
 * The effective set of system roles for an admin user.
 *
 * Multi-role users carry a non-empty `roles` array; legacy single-role
 * users have an empty `roles` and are represented by the singular `role`
 * column. This normalizes both into one deduped list that ALWAYS contains
 * the primary `role` (so a half-migrated row — non-empty `roles` that
 * somehow omits `role` — can never silently drop the user's base role).
 *
 * Unknown / stale enum strings are filtered out so a bad DB value can't
 * widen access. The result is never empty for a valid user: it falls back
 * to `[role]`, and if even `role` is unrecognized, to `[]` (caller decides
 * — every gate treats `[]` as "no roles" = least privilege).
 */
export function getEffectiveRoles(
  role: string,
  roles: readonly string[] | null | undefined,
): AdminRole[] {
  const set = new Set<AdminRole>();
  // Primary role first so it's always present in the effective set.
  if (isAdminRole(role)) set.add(role);
  for (const r of roles ?? []) {
    if (isAdminRole(r)) set.add(r);
  }
  return [...set];
}

/**
 * Pick the single canonical/primary role from an effective role set — the
 * highest-privilege member (admin first) — or `null` when NO recognized
 * role survives (empty set, or only unknown/stale strings, e.g. a new DB
 * enum value shipped ahead of code).
 *
 * FAIL-CLOSED: `null` means "no recognized role" and callers MUST treat it
 * as no-access / least privilege. It must never be papered over with a
 * fabricated role — `verifySession` denies such a session outright, and
 * routing falls back to the legacy empty-roles path.
 */
export function pickPrimaryRoleOrNull(
  roles: readonly string[],
): AdminRole | null {
  let best: AdminRole | null = null;
  for (const r of roles) {
    if (!isAdminRole(r)) continue;
    if (best === null || ROLE_PRIORITY[r] < ROLE_PRIORITY[best]) best = r;
  }
  return best;
}

/**
 * Always-a-role variant of {@link pickPrimaryRoleOrNull}. Used to keep the
 * singular `role` column / session field in sync when roles change. Every
 * caller passes a set that already contains at least one recognized role
 * (validated/normalized upstream, or a DB row that includes the existing
 * primary), so the fallback is unreachable in practice — it exists as a
 * type-level safety net only. It resolves to the LOWEST-privilege built-in
 * role, NEVER `admin`: the old `?? "admin"` fallback turned an unrecognized
 * role string into a full superuser session (requireAdmin/requirePageAccess
 * bypass). A session minted with the fallback grants nothing anyway —
 * `verifySession` re-derives the role set DB-fresh on every request and
 * fails closed when no recognized role survives.
 */
export function pickPrimaryRole(roles: readonly string[]): AdminRole {
  return pickPrimaryRoleOrNull(roles) ?? "pack_creator";
}

/**
 * Landing route for a SINGLE role (legacy signature, kept for the many
 * call sites that pass one role string). Multi-role users should resolve
 * their primary role via `pickPrimaryRole` first and pass that here —
 * `getDefaultRouteForRoles` does exactly that.
 */
export function getDefaultRoute(role: string, allowedPages?: string[]): string {
  if (role === "admin") return "/dashboard";
  // A dedicated Creator-Hub manager's whole job lives in the Hub — land
  // them straight on its dashboard. (admin reaches both the main dashboard
  // and the Hub via the portal button; this branch only fires for a user
  // whose PRIMARY role is creator_manager, i.e. without a higher-priority
  // support/marketing role.)
  if (role === "creator_manager") return "/creator-hub";
  if (role === "creator") return "/my-profile";
  // pack_creator's whole job is creating packs — land them straight on the
  // packs page so they don't have to navigate.
  if (role === "pack_creator") return "/pack-studio";
  // Prefer the dashboard as the landing page whenever this user can
  // actually reach it. Without this, the default was whatever happened to
  // be FIRST in allowed_pages — so a user with dashboard access but
  // "/users" first in their list got bounced to /users on every reload.
  if (allowedPages?.includes("/dashboard")) return "/dashboard";
  if (allowedPages && allowedPages.length > 0) return allowedPages[0];
  return "/dashboard";
}

/**
 * Landing route for a multi-role user: resolve the highest-privilege
 * primary role, then defer to the existing single-role routing. Empty
 * roles falls back to `getDefaultRoute(role)` so behaviour is unchanged
 * for legacy single-role users.
 */
export function getDefaultRouteForRoles(
  roles: readonly string[],
  allowedPages?: string[],
): string {
  const primary = pickPrimaryRoleOrNull(roles);
  // No recognized role (empty set OR only unknown strings) → identical
  // routing to the legacy empty-roles path (allowed-pages driven). Never
  // fabricate a role here — least of all admin's /dashboard landing.
  if (primary === null) return getDefaultRoute("", allowedPages);
  return getDefaultRoute(primary, allowedPages);
}

/** True when Pack Builder is the viewer's only effective built-in role. */
export function isDedicatedPackBuilder(
  roles: readonly AdminRole[],
): boolean {
  return roles.length === 1 && roles[0] === "pack_creator";
}

/**
 * The only main-dashboard route families a dedicated Pack Builder may enter.
 * Pack Studio remains their primary workspace; these are the three Content
 * catalog surfaces needed to manage the same packs, cards, and sets.
 */
export const PACK_BUILDER_CONTENT_PATHS = [
  "/packs",
  "/cards",
  "/sets",
] as const;

/** True when a pathname is one of the Pack Builder Content pages or a child. */
export function isPackBuilderContentPath(pathname: string): boolean {
  return PACK_BUILDER_CONTENT_PATHS.some(
    (base) => pathname === base || pathname.startsWith(`${base}/`),
  );
}
