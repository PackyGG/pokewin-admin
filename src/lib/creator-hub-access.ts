import { getEffectiveRoles, type AdminRole } from "@/lib/admin-roles";
import type { SessionPayload } from "@/lib/session";
import { getAdminSetting, setAdminSetting, SETTINGS_KEYS } from "@/lib/admin-settings";
import { isOwner } from "@/lib/owners";

/**
 * Creator-Hub access control (security-sensitive).
 *
 * The Creator Hub is a self-contained sub-app. RIGHT NOW it is reachable
 * ONLY by the founder account `motha`, PLUS — once an admin flips a toggle —
 * by everyone holding a specific role. Two per-role on/off switches live in
 * the ADMIN DB (`admin_settings` key/value store), BOTH DEFAULT OFF:
 *
 *   • `creator_hub_access_admin_enabled`           — lets every `admin` in.
 *   • `creator_hub_access_creator_manager_enabled` — lets every
 *     `creator_manager` in.
 *
 * Effective rule (single source of truth for BOTH the portal button
 * visibility in the sidebar AND the /creator-hub route guard):
 *
 *   canAccess = username === 'motha'
 *               OR settings[<each of the viewer's effective roles> + '_enabled'] === true
 *
 * With both toggles false, ONLY `motha` sees the portal and can load the
 * Hub — every other user (including other admins) is blocked. This is the
 * default, hardened, fail-closed posture: any unknown role, a missing
 * `admin_settings` table, or a transient DB read failure all collapse to
 * "not allowed" (except the hard-coded `motha` bypass, which never depends
 * on the DB).
 */

/**
 * The roles that carry a per-role Creator-Hub access toggle. These are the
 * only roles a toggle can ever grant — every other effective role is
 * ignored by the gate (fail-closed).
 */
export const CREATOR_HUB_TOGGLE_ROLES = [
  "admin",
  "creator_manager",
] as const satisfies readonly AdminRole[];

export type CreatorHubToggleRole = (typeof CREATOR_HUB_TOGGLE_ROLES)[number];

/**
 * Resolved on/off state of every per-role Creator-Hub toggle. A role maps
 * to `true` only when its ADMIN-DB setting is explicitly the string
 * `"true"`; anything else (unset, table missing, malformed) is `false`.
 */
export type CreatorHubAccessSettings = Record<CreatorHubToggleRole, boolean>;

/** The `admin_settings` key that stores a given role's toggle. */
export function creatorHubToggleKey(role: CreatorHubToggleRole): string {
  return SETTINGS_KEYS.CREATOR_HUB_ACCESS_PREFIX + role + "_enabled";
}

/** True only for the canonical string we persist for an enabled toggle. */
function parseBool(value: string | null): boolean {
  return value === "true";
}

/**
 * Load the per-role Creator-Hub access toggles from the ADMIN DB.
 *
 * Reads through {@link getAdminSetting}, which already degrades a missing
 * `admin_settings` table to `null` — so a pre-migration DB yields all
 * toggles OFF (fail-closed) rather than throwing. Server-side only
 * (touches `adminDb`); never call from a Client Component.
 */
export async function getCreatorHubAccessSettings(): Promise<CreatorHubAccessSettings> {
  const entries = await Promise.all(
    CREATOR_HUB_TOGGLE_ROLES.map(
      async (role): Promise<[CreatorHubToggleRole, boolean]> => [
        role,
        parseBool(await getAdminSetting(creatorHubToggleKey(role))),
      ],
    ),
  );
  return Object.fromEntries(entries) as CreatorHubAccessSettings;
}

/**
 * Persist one per-role Creator-Hub toggle. Stores the canonical `"true"` /
 * `"false"` string and stamps `updated_by` with the acting admin. Throws
 * `AdminSettingsTableMissingError` (from {@link setAdminSetting}) if the
 * table isn't available yet so the caller can surface a clear toast.
 */
export async function setCreatorHubAccessSetting(
  role: CreatorHubToggleRole,
  enabled: boolean,
  adminUserId: string,
): Promise<void> {
  await setAdminSetting(
    creatorHubToggleKey(role),
    enabled ? "true" : "false",
    adminUserId,
  );
}

/**
 * THE access decision. Pure + synchronous so it can be unit-reasoned and
 * reused verbatim by the sidebar (server-computed prop) and the route
 * guard. Pass the verified session + the loaded toggle settings.
 *
 * `motha` always passes (DB-independent bypass). Otherwise the viewer
 * passes iff at least one of their effective roles has its toggle enabled.
 */
export function canAccessCreatorHub(
  session: Pick<SessionPayload, "username" | "role" | "roles" | "isOwner">,
  settings: CreatorHubAccessSettings,
): boolean {
  // Owner bypass (was a hard-coded `motha`-username bypass). Any owner always
  // passes, DB-toggle-independent. `isOwner` is read DB-fresh by verifySession;
  // the permanent `motha` username is owner regardless.
  if (isOwner(session)) {
    return true;
  }
  const roles = getEffectiveRoles(session.role, session.roles);
  return roles.some(
    (role) =>
      (CREATOR_HUB_TOGGLE_ROLES as readonly string[]).includes(role) &&
      settings[role as CreatorHubToggleRole] === true,
  );
}

/**
 * True if this user controls the Creator-Hub access toggles. Now OWNER-gated
 * (was `motha`-only by username) — any owner can flip the per-role toggles.
 */
export function isCreatorHubAccessOwner(
  session: Pick<SessionPayload, "username" | "isOwner">,
): boolean {
  return isOwner(session);
}
