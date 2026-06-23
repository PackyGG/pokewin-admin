import { type AdminRole } from "@/lib/admin-roles";
import type { SessionPayload } from "@/lib/session";
import { getAdminSetting } from "@/lib/admin-settings";
import { isMainOwner } from "@/lib/owners";

/**
 * Pack-Studio access control (security-sensitive).
 *
 * HARD-LOCKED to the MAIN owner (motha) only — no role toggles, no
 * promoted-owner access, no admins. This is the strictest posture: the
 * pack-tuning surfaces (catalog re-shape, lottery skew, history revert)
 * touch real-money packs, so the access set is the single account that
 * the platform's source of truth (`MAIN_OWNER_USERNAME = "motha"`)
 * recognises as root.
 *
 * Effective rule (single source of truth for BOTH the portal button
 * visibility in the sidebar AND the /pack-studio route guard):
 *
 *   canAccess = isMainOwner(session)   // username === "motha"
 *
 * The role-toggle plumbing below is kept dormant for any future re-broadening
 * — flipping a toggle currently has NO effect because `canAccessPackStudio`
 * ignores them. To re-enable roles later, restore the role-OR branch in
 * `canAccessPackStudio` below.
 */

/**
 * The roles that carry a per-role Pack-Studio access toggle. These are the
 * only roles a toggle can ever grant — every other effective role is
 * ignored by the gate (fail-closed).
 */
export const PACK_STUDIO_TOGGLE_ROLES = [
  "admin",
] as const satisfies readonly AdminRole[];

export type PackStudioToggleRole = (typeof PACK_STUDIO_TOGGLE_ROLES)[number];

/**
 * Resolved on/off state of every per-role Pack-Studio toggle. A role maps
 * to `true` only when its ADMIN-DB setting is explicitly the string
 * `"true"`; anything else (unset, table missing, malformed) is `false`.
 */
export type PackStudioAccessSettings = Record<PackStudioToggleRole, boolean>;

/** The `admin_settings` key that stores a given role's toggle. */
export function packStudioToggleKey(role: PackStudioToggleRole): string {
  return "pack_studio_access_" + role + "_enabled";
}

/** True only for the canonical string we persist for an enabled toggle. */
function parseBool(value: string | null): boolean {
  return value === "true";
}

/**
 * Load the per-role Pack-Studio access toggles from the ADMIN DB.
 *
 * Reads through {@link getAdminSetting}, which already degrades a missing
 * `admin_settings` table to `null` — so a pre-migration DB yields all
 * toggles OFF (fail-closed) rather than throwing. Server-side only
 * (touches `adminDb`); never call from a Client Component.
 */
export async function getPackStudioAccessSettings(): Promise<PackStudioAccessSettings> {
  const entries = await Promise.all(
    PACK_STUDIO_TOGGLE_ROLES.map(
      async (role): Promise<[PackStudioToggleRole, boolean]> => [
        role,
        parseBool(await getAdminSetting(packStudioToggleKey(role))),
      ],
    ),
  );
  return Object.fromEntries(entries) as PackStudioAccessSettings;
}

/**
 * THE access decision. Pure + synchronous so it can be unit-reasoned and
 * reused verbatim by the sidebar (server-computed prop) and the route
 * guard.
 *
 * HARD-LOCKED to the MAIN owner (motha) only. The `settings` parameter is
 * retained for callsite compatibility (and for future role-toggle reuse),
 * but is currently IGNORED — no other account passes, ever, regardless of
 * role, `is_owner` flag, or any DB toggle. Username is checked
 * DB-independently so the root account can never lock itself out.
 */
export function canAccessPackStudio(
  session: Pick<SessionPayload, "username" | "role" | "roles" | "isOwner">,
  _settings: PackStudioAccessSettings,
): boolean {
  return isMainOwner(session);
}
