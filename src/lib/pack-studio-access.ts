import { getEffectiveRoles, type AdminRole } from "@/lib/admin-roles";
import type { SessionPayload } from "@/lib/session";
import { getAdminSetting } from "@/lib/admin-settings";
import { isOwner } from "@/lib/owners";

/**
 * Pack-Studio access control (security-sensitive).
 *
 * Pack Studio is a self-contained sub-app (a sibling to the Creator Hub).
 * RIGHT NOW it is reachable ONLY by an owner account, PLUS — once an admin
 * flips a toggle — by everyone holding the `admin` role. The per-role
 * on/off switch lives in the ADMIN DB (`admin_settings` key/value store),
 * DEFAULT OFF:
 *
 *   • `pack_studio_access_admin_enabled` — lets every `admin` in.
 *
 * Effective rule (single source of truth for BOTH the portal button
 * visibility in the sidebar AND the /pack-studio route guard):
 *
 *   canAccess = isOwner(session)
 *               OR settings[<each of the viewer's effective roles>] === true
 *
 * With the toggle false, ONLY owners see the portal and can load the
 * Studio — every other user (including non-owner admins) is blocked. This
 * is the default, hardened, fail-closed posture: any unknown role, a
 * missing `admin_settings` table, or a transient DB read failure all
 * collapse to "not allowed" (except the owner bypass, which never depends
 * on the DB toggle).
 *
 * Modeled 1:1 on `@/lib/creator-hub-access`.
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
 * guard. Pass the verified session + the loaded toggle settings.
 *
 * An owner always passes (DB-independent bypass). Otherwise the viewer
 * passes iff at least one of their effective roles has its toggle enabled.
 */
export function canAccessPackStudio(
  session: Pick<SessionPayload, "username" | "role" | "roles" | "isOwner">,
  settings: PackStudioAccessSettings,
): boolean {
  if (isOwner(session)) {
    return true;
  }
  const roles = getEffectiveRoles(session.role, session.roles);
  return roles.some(
    (role) =>
      (PACK_STUDIO_TOGGLE_ROLES as readonly string[]).includes(role) &&
      settings[role as PackStudioToggleRole] === true,
  );
}
