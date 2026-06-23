import { getEffectiveRoles, type AdminRole } from "@/lib/admin-roles";
import type { SessionPayload } from "@/lib/session";
import { getAdminSetting } from "@/lib/admin-settings";
import { isOwner } from "@/lib/owners";

/**
 * Pack-Studio access control (security-sensitive).
 *
 * Open to: the MAIN owner (motha) + any super-owner (admin_users.is_owner)
 * + any account with the `admin` role. Lower-tier roles (support, marketing,
 * creator, pack_creator) are blocked.
 *
 * Effective rule (single source of truth for BOTH the portal button
 * visibility in the sidebar AND the /pack-studio route guard):
 *
 *   canAccess = isOwner(session)                              // motha + super owners
 *               OR getEffectiveRoles(session).includes("admin")
 *
 * The role-toggle plumbing below is kept for any future per-role broadening
 * but is currently IGNORED — the gate uses the role-based rule above directly,
 * so admins are in by default without needing any admin_settings flag flipped.
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
 * Open to: owners (motha, plus any account flagged `is_owner` in the
 * admin DB) AND accounts whose effective roles include "admin". Lower-tier
 * roles (support, marketing, creator, pack_creator) are blocked.
 *
 * The `settings` parameter is retained for callsite compatibility (and for
 * future per-role broadening) but is currently IGNORED — admins are in by
 * default without any admin_settings toggle.
 */
export function canAccessPackStudio(
  session: Pick<SessionPayload, "username" | "role" | "roles" | "isOwner">,
  _settings: PackStudioAccessSettings,
): boolean {
  if (isOwner(session)) return true;
  return getEffectiveRoles(session.role, session.roles).includes("admin");
}
