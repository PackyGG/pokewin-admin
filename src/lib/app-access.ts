import "server-only";

import type { SessionPayload } from "@/lib/session";
import {
  getEffectiveRoles,
  isDedicatedPackBuilder,
} from "@/lib/admin-roles";
import { isNextControlFlowError } from "@/lib/utils/action-error";
import {
  canAccessCreatorHub,
  getCreatorHubAccessSettings,
  CREATOR_HUB_TOGGLE_ROLES,
  type CreatorHubAccessSettings,
} from "@/lib/creator-hub-access";
import {
  canAccessPackStudio,
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
  /** Dedicated Pack Builders enter Admin at their first allowed Content page. */
  admin: boolean;
  adminHref?: string;
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
  const [hubSettings, fraudSettings, fraudUsers] =
    await Promise.all([
      safeCreatorHubSettings(),
      safeAntifraudSettings(),
      safeAntifraudUsers(),
    ]);

  const dedicatedPackBuilder = isDedicatedPackBuilder(
    getEffectiveRoles(session.role, session.roles),
  );

  if (dedicatedPackBuilder) {
    return {
      admin: true,
      adminHref: "/packs",
      creatorHub: false,
      packStudio: true,
      antifraud: false,
    };
  }

  return {
    admin: true,
    creatorHub: canAccessCreatorHub(session, hubSettings),
    packStudio: canAccessPackStudio(session),
    antifraud: canAccessAntifraud(session, fraudSettings, fraudUsers),
  };
}
