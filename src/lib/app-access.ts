import "server-only";

import type { SessionPayload } from "@/lib/session";
import { isNextControlFlowError } from "@/lib/utils/action-error";
import {
  canAccessCreatorHub,
  getCreatorHubAccessSettings,
  CREATOR_HUB_TOGGLE_ROLES,
  type CreatorHubAccessSettings,
} from "@/lib/creator-hub-access";
import {
  canAccessPackStudio,
  getPackStudioAccessSettings,
  getPackStudioUserAccess,
  PACK_STUDIO_TOGGLE_ROLES,
  type PackStudioAccessSettings,
  type PackStudioUserAccess,
} from "@/lib/pack-studio-access";
import {
  canAccessAntifraud,
  deniedAntifraudSettings,
  getAntifraudAccessSettings,
  getAntifraudUserAccess,
  type AntifraudAccessSettings,
  type AntifraudUserAccess,
} from "@/lib/antifraud/access";

/**
 * WHICH APPS A VIEWER MAY ENTER — one answer, computed once, shared by every
 * shell.
 *
 * The dashboard is four apps behind one session (Admin, Creator Hub, Pack
 * Studio, Antifraud) and each sidebar renders the same `<AppSwitcher>`. That
 * switcher must only ever show a door the viewer would actually get through, so
 * the decision has to be made SERVER-SIDE — it depends on ADMIN-DB toggles and
 * per-username allow/denylists the client cannot read.
 *
 * Every read here is resilient: a transient admin-DB fault degrades to the
 * fail-closed fallback (every toggle OFF, empty allow/denylists) rather than
 * throwing, so a blip can neither white-screen a shell nor reveal a door. The
 * hard-coded owner bypasses inside each `canAccess*` still apply.
 *
 * NOT a security boundary — each sub-app layout keeps its own gate against
 * fresh state. This only decides what the nav shows.
 */
export type AppAccess = {
  /** Always true: every account has the main dashboard. */
  admin: true;
  creatorHub: boolean;
  packStudio: boolean;
  antifraud: boolean;
};

async function safeCreatorHubSettings(): Promise<CreatorHubAccessSettings> {
  try {
    return await getCreatorHubAccessSettings();
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error("[app-access] creator-hub settings failed, closing door:", err);
    return Object.fromEntries(
      CREATOR_HUB_TOGGLE_ROLES.map((role) => [role, false]),
    ) as CreatorHubAccessSettings;
  }
}

async function safePackStudioSettings(): Promise<PackStudioAccessSettings> {
  try {
    return await getPackStudioAccessSettings();
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error("[app-access] pack-studio settings failed, closing door:", err);
    return Object.fromEntries(
      PACK_STUDIO_TOGGLE_ROLES.map((role) => [role, false]),
    ) as PackStudioAccessSettings;
  }
}

async function safePackStudioUsers(): Promise<PackStudioUserAccess> {
  try {
    return await getPackStudioUserAccess();
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error("[app-access] pack-studio overrides failed, role default:", err);
    return { allowlist: [], denylist: [] };
  }
}

async function safeAntifraudSettings(): Promise<AntifraudAccessSettings> {
  try {
    return await getAntifraudAccessSettings();
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error("[app-access] antifraud settings failed, closing door:", err);
    return deniedAntifraudSettings();
  }
}

async function safeAntifraudUsers(): Promise<AntifraudUserAccess> {
  try {
    return await getAntifraudUserAccess();
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error("[app-access] antifraud overrides failed, role default:", err);
    return { allowlist: [], denylist: [] };
  }
}

/**
 * Resolve the whole switcher in one parallel wave. Safe to start alongside a
 * layout's other reads: it resolves rather than rejects, so leaving it in
 * flight on a redirect path can't produce an unhandled rejection.
 */
export async function resolveAppAccess(
  session: Pick<SessionPayload, "username" | "role" | "roles" | "isOwner">,
): Promise<AppAccess> {
  const [hubSettings, studioSettings, studioUsers, fraudSettings, fraudUsers] =
    await Promise.all([
      safeCreatorHubSettings(),
      safePackStudioSettings(),
      safePackStudioUsers(),
      safeAntifraudSettings(),
      safeAntifraudUsers(),
    ]);

  return {
    admin: true,
    creatorHub: canAccessCreatorHub(session, hubSettings),
    packStudio: canAccessPackStudio(session, studioSettings, studioUsers),
    antifraud: canAccessAntifraud(session, fraudSettings, fraudUsers),
  };
}
