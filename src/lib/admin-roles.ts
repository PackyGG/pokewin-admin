export type AdminRole =
  | "admin"
  | "support"
  | "marketing"
  | "creator"
  | "pack_creator";

/** Every built-in system role, in highest → lowest privilege order. */
export const ALL_ADMIN_ROLES: readonly AdminRole[] = [
  "admin",
  "support",
  "marketing",
  "creator",
  "pack_creator",
];

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
  creator: 3,
  pack_creator: 4,
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
  if (role === "creator") return "/my-profile";
  // pack_creator's whole job is creating packs — land them straight on the
  // packs page so they don't have to navigate.
  if (role === "pack_creator") return "/packs";
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
