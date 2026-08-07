import { ALL_PAGE_KEYS, PAGE_ACCESS_ALIASES } from "@/lib/admin-pages";

// ---------------------------------------------------------------------------
// RoleV2 P4 — per-role landing-route validation (PURE, no DB, no server-only).
//
// A role's optional `landing_route` is an OVERRIDE: when set AND valid, a
// non-admin holder lands there after auth instead of the role's default
// surface (getDefaultRouteForRoles). NULL on every row = today's routing —
// strictly behavior-neutral.
//
// Validation guards against redirect loops: the value MUST be a known admin
// page key (an `ADMIN_PAGES` key, or a legacy alias that resolves to one). An
// unknown / malformed value is treated as "no landing override" so a typo can
// never bounce a user into a non-existent route.
// ---------------------------------------------------------------------------

// The full set of accepted landing targets: every live ADMIN_PAGES key plus the
// legacy permission-key aliases that still resolve to a real page
// (PAGE_ACCESS_ALIASES keys), so a stored alias landing route stays valid.
const VALID_LANDING_ROUTES: ReadonlySet<string> = new Set<string>([
  ...ALL_PAGE_KEYS,
  ...Object.keys(PAGE_ACCESS_ALIASES),
]);

/** True if `route` is a known admin page key usable as a landing target. */
function isValidLandingRoute(route: string): boolean {
  return VALID_LANDING_ROUTES.has(route);
}

/**
 * Normalize a raw landing-route input to what should be PERSISTED:
 *   • `null` / empty / whitespace            → `null` (clear the override)
 *   • a known ADMIN_PAGES key (or alias)      → that key
 *   • anything else                           → `undefined` (INVALID — reject)
 *
 * The caller rejects `undefined`; `null` is a valid "clear" and is stored.
 */
export function normalizeLandingRouteInput(
  raw: string | null | undefined,
): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  const t = raw.trim();
  if (t === "") return null;
  return isValidLandingRoute(t) ? t : undefined;
}

/**
 * Resolve a stored landing route to the route to redirect to, or `null` to
 * fall through to the default routing. A stored value that is no longer valid
 * (e.g. the page was removed) resolves to `null` — never a dead route.
 */
export function resolveLandingRoute(
  stored: string | null | undefined,
): string | null {
  if (!stored) return null;
  return isValidLandingRoute(stored) ? stored : null;
}
