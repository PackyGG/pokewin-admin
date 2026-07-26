import { cache } from "react";
import { getEffectiveRoles, type AdminRole } from "@/lib/admin-roles";
import type { SessionPayload } from "@/lib/session";
import { getAdminSetting, setAdminSetting } from "@/lib/admin-settings";
import { isOwner } from "@/lib/owners";

/**
 * Pack-Studio access control (security-sensitive).
 *
 * Open by default to: the MAIN owner (motha) + any super-owner
 * (admin_users.is_owner) + any account with the `admin` role. Lower-tier roles
 * (support, marketing, creator, pack_creator) are blocked.
 *
 * Two ADMIN-DB-stored per-username overrides ride on top of the role default
 * so the OWNER can flip any individual account's access with one click without
 * touching their role:
 *
 *   • `pack_studio_user_allowlist` — comma-separated usernames that are ALWAYS
 *     allowed (overrides the role default if they wouldn't otherwise pass).
 *   • `pack_studio_user_denylist`  — comma-separated usernames that are ALWAYS
 *     denied (overrides EVERYTHING below owner — i.e. an admin can be revoked
 *     by listing their username here, but an owner can never be locked out).
 *
 * Effective rule (single source of truth for BOTH the portal button
 * visibility in the sidebar AND the /pack-studio route guard):
 *
 *   canAccess = isOwner(session)                                              // motha + super owners (cannot be denied)
 *               OR ( !denylist.has(username)
 *                    AND ( allowlist.has(username)
 *                          OR getEffectiveRoles(session).includes("admin") ) )
 *
 * The role-toggle plumbing below is kept for any future per-role broadening
 * but is currently IGNORED — the gate uses the rule above directly, so
 * admins are in by default without needing any admin_settings flag flipped.
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
 * (touches the admin database); never call from a Client Component.
 *
 * `React.cache`-wrapped: the pack-studio access trio is read up to 3× per
 * request (layout gate, page gate, `requireRetuneOwner` action gate) — the
 * request-scoped memo collapses those onto ONE ADMIN read each.
 */
export const getPackStudioAccessSettings = cache(
  async (): Promise<PackStudioAccessSettings> => {
    const entries = await Promise.all(
      PACK_STUDIO_TOGGLE_ROLES.map(
        async (role): Promise<[PackStudioToggleRole, boolean]> => [
          role,
          parseBool(await getAdminSetting(packStudioToggleKey(role))),
        ],
      ),
    );
    return Object.fromEntries(entries) as PackStudioAccessSettings;
  },
);

/**
 * THE access decision. Pure + synchronous so it can be unit-reasoned and
 * reused verbatim by the sidebar (server-computed prop) and the route
 * guard.
 *
 * Open to: owners (motha, plus any account flagged `is_owner` in the admin
 * DB) — owners can NEVER be denied. Then: any account whose username is on
 * the per-user allowlist OR whose effective roles include "admin", as long
 * as they are NOT on the per-user denylist. Lower-tier roles (support,
 * marketing, creator, pack_creator) are blocked unless explicitly allowlisted.
 *
 * The `settings` parameter is retained for callsite compatibility (and for
 * future per-role broadening) but is currently IGNORED — admins are in by
 * default without any admin_settings role toggle.
 */
export function canAccessPackStudio(
  session: Pick<SessionPayload, "username" | "role" | "roles" | "isOwner">,
  _settings: PackStudioAccessSettings,
  userAccess?: PackStudioUserAccess,
): boolean {
  if (isOwner(session)) return true;
  const username = normalizeUsername(session.username);
  if (userAccess && username && userAccess.denylist.includes(username)) {
    return false;
  }
  if (userAccess && username && userAccess.allowlist.includes(username)) {
    return true;
  }
  return getEffectiveRoles(session.role, session.roles).includes("admin");
}

// ─── Per-username allow / deny lists (owner-managed) ─────────────────────

/** The `admin_settings` keys that store the comma-separated username lists. */
export const PACK_STUDIO_USER_ALLOWLIST_KEY = "pack_studio_user_allowlist";
export const PACK_STUDIO_USER_DENYLIST_KEY = "pack_studio_user_denylist";

/** Resolved per-username allow/deny lists, lowercased + de-duped. */
export type PackStudioUserAccess = {
  allowlist: string[];
  denylist: string[];
};

/** Lowercase + trim, returns "" for nullish input (matches `owners.ts`). */
function normalizeUsername(username: string | null | undefined): string {
  return (username ?? "").trim().toLowerCase();
}

/**
 * Parse a stored comma-separated username string into a normalized list.
 * Skips empty entries, trims/lowercases, drops duplicates. A `null` (key
 * unset / table missing) yields `[]`.
 */
function parseUsernameList(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const u = normalizeUsername(part);
    if (!u) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/** Serialize a username list back into the stored comma-separated form. */
function serializeUsernameList(list: readonly string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of list) {
    const u = normalizeUsername(part);
    if (!u) continue;
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out.join(",");
}

/**
 * Load the per-username Pack-Studio access overrides from the ADMIN DB.
 * Resilient: a missing `admin_settings` table degrades to empty lists (the
 * role-based default still applies). Server-side only.
 *
 * `React.cache`-wrapped (see {@link getPackStudioAccessSettings}): one ADMIN
 * read per request no matter how many gates re-check access.
 */
export const getPackStudioUserAccess = cache(
  async (): Promise<PackStudioUserAccess> => {
    const [allowRaw, denyRaw] = await Promise.all([
      getAdminSetting(PACK_STUDIO_USER_ALLOWLIST_KEY),
      getAdminSetting(PACK_STUDIO_USER_DENYLIST_KEY),
    ]);
    return {
      allowlist: parseUsernameList(allowRaw),
      denylist: parseUsernameList(denyRaw),
    };
  },
);

/**
 * Persist one per-username Pack-Studio override list. Stores the normalized
 * comma-separated string and stamps `updated_by` with the acting admin.
 * Throws `AdminSettingsTableMissingError` (from {@link setAdminSetting})
 * when the table isn't migrated yet so the caller can show a clear toast.
 */
export async function setPackStudioUserList(
  list: "allowlist" | "denylist",
  usernames: readonly string[],
  adminUserId: string,
): Promise<void> {
  const key =
    list === "allowlist"
      ? PACK_STUDIO_USER_ALLOWLIST_KEY
      : PACK_STUDIO_USER_DENYLIST_KEY;
  await setAdminSetting(key, serializeUsernameList(usernames), adminUserId);
}
