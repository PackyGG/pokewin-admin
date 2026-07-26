import { cache } from "react";
import {
  getEffectiveRoles,
  isDedicatedPackBuilder,
  type AdminRole,
} from "@/lib/admin-roles";
import type { SessionPayload } from "@/lib/session";
import { getAdminSetting, setAdminSetting } from "@/lib/admin-settings";
import { isOwner } from "@/lib/owners";

/**
 * Antifraud-workspace access control (security-sensitive).
 *
 * The Antifraud app is the THIRD sub-app in this dashboard (after Creator Hub
 * and Pack Studio) and will eventually be served from its own host,
 * `fraud.packydash.com` — see `src/lib/antifraud/host.ts`. It is the home of
 * the support-staff system (levels / points / quizzes) and the account-review
 * queue fed by the separate fraud backend.
 *
 * Same shape as the Pack-Studio gate, deliberately: one pure decision function
 * shared 1:1 by the sidebar portal button and every route guard, so a user can
 * never see a door they'd be bounced out of.
 *
 *   canAccess = isOwner(session)                                  // never deniable
 *               OR ( !denylist.has(username)
 *                    AND ( allowlist.has(username)
 *                          OR roles.includes('admin')             // admins are in by default
 *                          OR ANY of the viewer's roles has its
 *                             ADMIN-DB toggle enabled ) )
 *
 * The per-role toggles exist because the antifraud workspace is a STAFF tool,
 * not an owner tool: the whole point is that support (and whoever else the
 * owner nominates) works cases in it. `support` is enabled in the live admin DB
 * so the team is in from day one; every other toggle defaults OFF and any DB
 * fault degrades to OFF (fail-closed).
 */

/**
 * The roles that carry a per-role Antifraud access toggle. These are the only
 * roles a toggle can ever grant — every other effective role is ignored by the
 * gate (fail-closed). `admin` is NOT here: admins are in unconditionally (like
 * Pack Studio), so there is nothing to toggle.
 */
export const ANTIFRAUD_TOGGLE_ROLES = [
  "support",
  "marketing",
  "creator_manager",
] as const satisfies readonly AdminRole[];

export type AntifraudToggleRole = (typeof ANTIFRAUD_TOGGLE_ROLES)[number];

/**
 * Resolved on/off state of every per-role toggle. A role maps to `true` only
 * when its ADMIN-DB setting is explicitly the string `"true"`; anything else
 * (unset, table missing, malformed) is `false`.
 */
export type AntifraudAccessSettings = Record<AntifraudToggleRole, boolean>;

/** The `admin_settings` key that stores a given role's toggle. */
export function antifraudToggleKey(role: AntifraudToggleRole): string {
  return "antifraud_access_" + role + "_enabled";
}

/** True only for the canonical string we persist for an enabled toggle. */
function parseBool(value: string | null): boolean {
  return value === "true";
}

/**
 * Load the per-role Antifraud access toggles from the ADMIN DB.
 *
 * Reads through {@link getAdminSetting}, which already degrades a missing
 * `admin_settings` table to `null` — so a pre-migration DB yields all toggles
 * OFF (fail-closed) rather than throwing. Server-side only (touches Admin DB);
 * never call from a Client Component.
 *
 * `React.cache`-wrapped: the trio is read up to 3× per request (portal button,
 * layout gate, page gate) — the request-scoped memo collapses those onto ONE
 * ADMIN read each.
 */
export const getAntifraudAccessSettings = cache(
  async (): Promise<AntifraudAccessSettings> => {
    const entries = await Promise.all(
      ANTIFRAUD_TOGGLE_ROLES.map(
        async (role): Promise<[AntifraudToggleRole, boolean]> => [
          role,
          parseBool(await getAdminSetting(antifraudToggleKey(role))),
        ],
      ),
    );
    return Object.fromEntries(entries) as AntifraudAccessSettings;
  },
);

/** Persist one per-role toggle, stamping `updated_by` with the acting admin. */
export async function setAntifraudAccessSetting(
  role: AntifraudToggleRole,
  enabled: boolean,
  adminUserId: string,
): Promise<void> {
  await setAdminSetting(
    antifraudToggleKey(role),
    enabled ? "true" : "false",
    adminUserId,
  );
}

// ─── Per-username allow / deny lists (owner-managed) ─────────────────────

export const ANTIFRAUD_USER_ALLOWLIST_KEY = "antifraud_user_allowlist";
export const ANTIFRAUD_USER_DENYLIST_KEY = "antifraud_user_denylist";

/** Resolved per-username allow/deny lists, lowercased + de-duped. */
export type AntifraudUserAccess = {
  allowlist: string[];
  denylist: string[];
};

/** Lowercase + trim, returns "" for nullish input (matches `owners.ts`). */
function normalizeUsername(username: string | null | undefined): string {
  return (username ?? "").trim().toLowerCase();
}

/** Parse a stored comma-separated username string into a normalized list. */
function parseUsernameList(raw: string | null): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const u = normalizeUsername(part);
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/** Serialize a username list back into the stored comma-separated form. */
function serializeUsernameList(list: readonly string[]): string {
  return parseUsernameList(list.join(",")).join(",");
}

/**
 * Load the per-username Antifraud access overrides from the ADMIN DB.
 * Resilient: a missing `admin_settings` table degrades to empty lists (the
 * role-based default still applies). Server-side only.
 */
export const getAntifraudUserAccess = cache(
  async (): Promise<AntifraudUserAccess> => {
    const [allowRaw, denyRaw] = await Promise.all([
      getAdminSetting(ANTIFRAUD_USER_ALLOWLIST_KEY),
      getAdminSetting(ANTIFRAUD_USER_DENYLIST_KEY),
    ]);
    return {
      allowlist: parseUsernameList(allowRaw),
      denylist: parseUsernameList(denyRaw),
    };
  },
);

/** Persist one per-username override list. */
export async function setAntifraudUserList(
  list: "allowlist" | "denylist",
  usernames: readonly string[],
  adminUserId: string,
): Promise<void> {
  const key =
    list === "allowlist"
      ? ANTIFRAUD_USER_ALLOWLIST_KEY
      : ANTIFRAUD_USER_DENYLIST_KEY;
  await setAdminSetting(key, serializeUsernameList(usernames), adminUserId);
}

/**
 * THE access decision. Pure + synchronous so it can be unit-reasoned and reused
 * verbatim by the sidebar (server-computed prop) and every route guard.
 *
 * Owners always pass and can NEVER be denied. Everyone else must clear the
 * denylist first, then pass via the allowlist, the `admin` role, or an enabled
 * per-role toggle.
 */
export function canAccessAntifraud(
  session: Pick<SessionPayload, "username" | "role" | "roles" | "isOwner">,
  settings: AntifraudAccessSettings,
  userAccess?: AntifraudUserAccess,
): boolean {
  if (isOwner(session)) return true;

  const roles = getEffectiveRoles(session.role, session.roles);
  if (isDedicatedPackBuilder(roles)) return false;

  const username = normalizeUsername(session.username);
  if (userAccess && username && userAccess.denylist.includes(username)) {
    return false;
  }
  if (userAccess && username && userAccess.allowlist.includes(username)) {
    return true;
  }

  if (roles.includes("admin")) return true;
  return roles.some(
    (role) =>
      (ANTIFRAUD_TOGGLE_ROLES as readonly string[]).includes(role) &&
      settings[role as AntifraudToggleRole] === true,
  );
}

/**
 * True iff this viewer may AUTHOR quizzes and manage the workspace settings
 * (the /antifraud/settings section). Owners + admins only — the request was
 * explicit that quiz creation is an owner/admin capability, while taking a quiz
 * is open to every staff member with workspace access.
 */
export function canManageAntifraud(
  session: Pick<SessionPayload, "username" | "role" | "roles" | "isOwner">,
): boolean {
  if (isOwner(session)) return true;
  return getEffectiveRoles(session.role, session.roles).includes("admin");
}

/** Fail-closed settings object — every toggle OFF. Used on any read failure. */
export function deniedAntifraudSettings(): AntifraudAccessSettings {
  return Object.fromEntries(
    ANTIFRAUD_TOGGLE_ROLES.map((role) => [role, false]),
  ) as AntifraudAccessSettings;
}
