import { Suspense } from "react";
import { redirect } from "next/navigation";

import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AdminHeader } from "@/components/admin-header";
import { TopProgressBar } from "@/components/top-progress-bar";
import { RightRailProvider } from "@/components/right-rail-context";
import { RailWidthSync } from "@/components/rail-width-sync";
import { readRailOpenOrder } from "@/lib/right-rail-server";
import { TimezoneProvider } from "@/components/timezone-provider";
import { DevDbBanner } from "@/components/dev-db-banner";

import { verifySession, getUserPermissions, sessionRoles } from "@/lib/dal";
import { getSession, type SessionPayload } from "@/lib/session";
import { getEffectiveRoles, getDefaultRouteForRoles } from "@/lib/admin-roles";
import {
  canAccessCreatorHub,
  getCreatorHubAccessSettings,
  CREATOR_HUB_TOGGLE_ROLES,
  type CreatorHubAccessSettings,
} from "@/lib/creator-hub-access";
import { eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/drizzle";
import { admin_users } from "@/lib/db-schema/admin/schema";
import { getAdminPreferences } from "@/lib/admin-preferences";
import { isPostgresError } from "@/lib/postgres-errors";
import { DEFAULT_PREFERENCES } from "@/lib/admin-preferences-types";
import { readDbEnvFromCookie, isDevDbConfigured } from "@/lib/db-env";
import { readTzCookie } from "@/lib/timezone/server";
import { isNextControlFlowError } from "@/lib/utils/action-error";
import { resolveAppAccess } from "@/lib/app-access";

// scroll-to-top island lives in the (admin) group; reused 1:1 here. The
// (creator-hub) and (admin) route groups are sibling directories on disk,
// so this relative path resolves across the group boundary.
import { ScrollToTopOnNav } from "../../(admin)/scroll-to-top-on-nav";
import { PageTransition } from "@/components/page-transition";
import { CreatorHubSidebar } from "./_components/creator-hub-sidebar";
import { DockedAlerts } from "./_components/docked-alerts";
import { CreatorChecklistDock } from "./creators/[id]/_components/creator-checklist-dock";

/**
 * Creator Hub layout — the dedicated route segment that renders the
 * Creator Hub as an "app inside the app". It reuses the SAME shell
 * geometry + providers as the main admin layout
 * (`src/app/(admin)/layout.tsx`) — SidebarProvider / SidebarInset,
 * TimezoneProvider, the AdminHeader, the right-rail docks — but swaps in
 * the `CreatorHubSidebar` instead of the main `AppSidebar`, so the user
 * enters a visually distinct sub-app while every auth / session / theme
 * provider keeps working unchanged.
 *
 * ACCESS: gated via `canAccessCreatorHub` (founder `motha` OR a per-role
 * ADMIN-DB toggle). Non-eligible viewers redirect to their landing route.
 * The "Switch to Creator Hub" portal button uses the same rule server-side.
 *
 * The resilient loaders below mirror the main layout's defensive reads so
 * a transient admin-DB fault degrades to safe fallbacks instead of
 * white-screening the sub-app shell.
 */

async function loadHeaderProfile(userId: string): Promise<{
  displayUsername: string | null;
  hasAvatar: boolean;
  email: string;
  /**
   * Whether the optional admin-DB profile columns exist — gates the profile
   * dialog's editing controls. Mirrors the main (admin) layout's loader so
   * the shared AdminHeader (and its profile popup) behaves identically here.
   */
  profileFieldsAvailable: boolean;
}> {
  try {
    const row = (
      await adminDrizzle
        .select({
          display_username: admin_users.display_username,
          profile_image_mime: admin_users.profile_image_mime,
          email: admin_users.email,
        })
        .from(admin_users)
        .where(eq(admin_users.id, userId))
        .limit(1)
    )[0];
    return {
      displayUsername: row?.display_username ?? null,
      hasAvatar: Boolean(row?.profile_image_mime),
      email: row?.email ?? "",
      profileFieldsAvailable: true,
    };
  } catch (err) {
    // Pre-migration fallback: the profile columns don't exist. Re-read just
    // the always-present `email` so the dialog identity still shows, and flag
    // the editing fields as unavailable.
    const missingColumn = isPostgresError(err, "42703");
    if (missingColumn) {
      try {
        const row = (
          await adminDrizzle
            .select({ email: admin_users.email })
            .from(admin_users)
            .where(eq(admin_users.id, userId))
            .limit(1)
        )[0];
        return {
          displayUsername: null,
          hasAvatar: false,
          email: row?.email ?? "",
          profileFieldsAvailable: false,
        };
      } catch (inner) {
        console.error("[creator-hub-layout] loadHeaderProfile email fallback failed:", inner);
      }
    }
    console.error("[creator-hub-layout] loadHeaderProfile failed:", err);
    return {
      displayUsername: null,
      hasAvatar: false,
      email: "",
      profileFieldsAvailable: false,
    };
  }
}

async function loadUserPermissions(userId: string): Promise<string[]> {
  try {
    return await getUserPermissions(userId);
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error("[creator-hub-layout] loadUserPermissions failed:", err);
    return [];
  }
}

/**
 * Resilient read of the per-role Creator-Hub access toggles. A transient
 * admin-DB fault must NOT silently widen access, so any failure degrades to
 * every toggle OFF (fail-closed) — only the hard-coded `motha` bypass in
 * `canAccessCreatorHub` survives a DB blip, which is the safe outcome for a
 * security gate.
 */
async function loadCreatorHubAccessSettings(): Promise<CreatorHubAccessSettings> {
  try {
    return await getCreatorHubAccessSettings();
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error(
      "[creator-hub-layout] loadCreatorHubAccessSettings failed, denying non-owner access:",
      err,
    );
    return Object.fromEntries(
      CREATOR_HUB_TOGGLE_ROLES.map((role) => [role, false]),
    ) as CreatorHubAccessSettings;
  }
}

async function loadPreferences(userId: string) {
  try {
    return await getAdminPreferences(userId);
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error("[creator-hub-layout] loadPreferences failed:", err);
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * Resilient session verify — identical contract to the main layout's:
 * cookie-missing / expired → redirect to /login; a transient DB fault on
 * the role/active re-read falls back to the signed JWT payload so a blip
 * doesn't tear down the whole sub-app.
 */
async function safeVerifySession(): Promise<SessionPayload> {
  try {
    return await verifySession();
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error(
      "[creator-hub-layout] safeVerifySession DB lookup failed, falling back to JWT:",
      err,
    );
    const session = await getSession();
    if (!session) redirect("/login");
    if (new Date(session.expiresAt) < new Date()) redirect("/login");
    const roles = getEffectiveRoles(session.role, session.roles);
    return { ...session, roles };
  }
}

export default async function CreatorHubLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await safeVerifySession();

  // Hub access gate (security-sensitive): username `motha` OR a per-role
  // toggle (ADMIN DB, both default OFF) enabled for one of the viewer's
  // effective roles — see `canAccessCreatorHub`. With both toggles off ONLY
  // motha reaches the Hub; everyone else (incl. other admins) is bounced to
  // their normal landing route. We resolve the redirect the same way the
  // DAL does so a non-eligible user lands somewhere they can actually use.
  const roles = sessionRoles(session);
  const hubAccessSettings = await loadCreatorHubAccessSettings();
  if (!canAccessCreatorHub(session, hubAccessSettings)) {
    const allowedPages = await loadUserPermissions(session.userId);
    redirect(getDefaultRouteForRoles(roles, allowedPages));
  }

  const [appAccess, profile, preferences, dbEnv, tzCookie, railOpenOrder] =
    await Promise.all([
      resolveAppAccess(session),
      loadHeaderProfile(session.userId),
      loadPreferences(session.userId),
      readDbEnvFromCookie(),
      readTzCookie(),
      // Open dock keys from the `admin_rail` cookie — seeds the rail so SSR +
      // first client paint match the admin's saved layout (no open/close
      // flip). Shared 1:1 with the main (admin) shell.
      readRailOpenOrder(),
    ]);

  const canSwitchDbEnv = session.role === "admin" && isDevDbConfigured();

  return (
    <TimezoneProvider
      initialTimezone={preferences.timezone}
      cookieTimezone={tzCookie}
      initialDateFormat={preferences.dateFormat}
    >
      <SidebarProvider>
        <Suspense fallback={null}>
          <TopProgressBar />
        </Suspense>
        {/* The swapped nav — Creator Hub's own sidebar replaces AppSidebar. */}
        <CreatorHubSidebar access={appAccess} />
        <SidebarInset className="min-w-0">
          {dbEnv === "dev" && <DevDbBanner />}
          <AdminHeader
            adminId={session.userId}
            username={session.username}
            displayUsername={profile.displayUsername}
            email={profile.email}
            hasAvatar={profile.hasAvatar}
            role={session.role}
            roles={session.roles ?? [session.role]}
            profileFieldsAvailable={profile.profileFieldsAvailable}
            preferences={preferences}
            dbEnv={dbEnv}
            canSwitchDbEnv={canSwitchDbEnv}
          />
          <div
            data-admin-scroll
            className="flex-1 overflow-auto min-w-0 p-3 sm:p-4 md:p-6 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-[max(1rem,env(safe-area-inset-bottom))] md:pb-[max(1.5rem,env(safe-area-inset-bottom))]"
          >
            <ScrollToTopOnNav />
            {/* Subtle route-enter animation, shared with the main admin +
                pack-studio shells so sub-app switches feel coherent. Keys on
                pathname only (in-page ?tab=/?period= don't re-animate); wraps
                the outer content so Suspense fallbacks still stream; no layout
                shift; reduced-motion → instant final state. */}
            <PageTransition>{children}</PageTransition>
          </div>
        </SidebarInset>
        {/* Onboarding checklist DOCK — the TOP of the right rail (above the
            live/recent docks), the owner's most-prominent rail item. It's a
            self-contained client island: it reads the `creators/[id]` id from
            the pathname, shows ONLY on a creator detail page, sits at `z-40`
            above the `z-30` rail, and auto-hides once that creator is fully
            onboarded. Lazy — it fetches nothing on any other Hub route. */}
        <CreatorChecklistDock />
        {/* Creator Hub keeps its separate Alerts dock. */}
        <RightRailProvider
          mounted={{ alerts: true }}
          initialOpenOrder={railOpenOrder}
        >
          <RailWidthSync />
          <DockedAlerts />
        </RightRailProvider>
      </SidebarProvider>
    </TimezoneProvider>
  );
}
