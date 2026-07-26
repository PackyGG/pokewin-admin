export type AdminRole =
  | "admin"
  | "support"
  | "marketing"
  | "creator"
  | "pack_creator"
  // Creator Hub manager — the in-house Creator-Marketing (CM) team role.
  // Lands on /creator-hub when it is the primary role. Hub entry is gated
  // via `canAccessCreatorHub` (founder motha OR per-role ADMIN-DB toggle).
  | "creator_manager";

/** Every built-in system role, in highest → lowest privilege order. */
export const ALL_ADMIN_ROLES: readonly AdminRole[] = [
  "admin",
  "support",
  "marketing",
  "creator",
  "pack_creator",
  "creator_manager",
];

/**
 * The subset of built-in roles that exist as values in the ADMIN-DB
 * `admin_role` Postgres enum and can therefore be PERSISTED on an
 * `admin_users` row. Must stay in sync with the `admin_role` Postgres enum
 * in the checked-in Admin Drizzle schema (apply additive reviewed Admin SQL
 * when extending).
 *
 * Any code path that builds a value to store in `admin_users.role` /
 * `admin_users.roles` (e.g. the create / set-roles admin actions) must
 * filter candidate roles through {@link isPersistableAdminRole} so a
 * code-only role never reaches the database. Pure in-memory role checks
 * (sidebar gating, `requireRole`, landing routes) use the full
 * `ALL_ADMIN_ROLES` / `isAdminRole` set and are unaffected.
 */
export const PERSISTABLE_ADMIN_ROLES: readonly AdminRole[] = [
  "admin",
  "support",
  "marketing",
  "creator",
  "pack_creator",
  "creator_manager",
];

const PERSISTABLE_ADMIN_ROLE_SET: ReadonlySet<string> = new Set(
  PERSISTABLE_ADMIN_ROLES,
);

/**
 * Type guard for a built-in role that can be stored in the ADMIN-DB
 * `admin_role` enum. Narrows to the exact database-enum string set so the
 * result is assignable to a `admin_role`-typed field. Drops unknown strings.
 */
export function isPersistableAdminRole(
  value: string,
): value is
  | "admin"
  | "support"
  | "marketing"
  | "creator"
  | "pack_creator"
  | "creator_manager" {
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
 * Pick the single canonical/primary role from an effective role set —
 * the highest-privilege member (admin first). Used to keep the singular
 * `role` column / session field in sync when roles change, and as the
 * landing-route driver. Falls back to `"admin"` only when the set is
 * empty, which should never happen for a real user (callers pass a set
 * that already includes the existing primary role).
 */
export function pickPrimaryRole(roles: readonly string[]): AdminRole {
  let best: AdminRole | null = null;
  for (const r of roles) {
    if (!isAdminRole(r)) continue;
    if (best === null || ROLE_PRIORITY[r] < ROLE_PRIORITY[best]) best = r;
  }
  return best ?? "admin";
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
  if (roles.length === 0) return getDefaultRoute("", allowedPages);
  return getDefaultRoute(pickPrimaryRole(roles), allowedPages);
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
