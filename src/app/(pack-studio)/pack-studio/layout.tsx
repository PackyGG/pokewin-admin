import { Suspense } from "react";
import { redirect, unstable_rethrow } from "next/navigation";
import { sql } from "drizzle-orm";

import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AdminHeader } from "@/components/admin-header";
import { TopProgressBar } from "@/components/top-progress-bar";
import { TimezoneProvider } from "@/components/timezone-provider";
import { DevDbBanner } from "@/components/dev-db-banner";

import { verifySession, getUserPermissions, sessionRoles } from "@/lib/dal";
import { getSession, type SessionPayload } from "@/lib/session";
import { getEffectiveRoles, getDefaultRouteForRoles } from "@/lib/admin-roles";
import { canAccessPackStudio } from "@/lib/pack-studio-access";
import { adminDrizzle } from "@/lib/admin-db";
import { isOwner } from "@/lib/owners";
import { isPackStudioRetuneOperator } from "@/lib/reprice-access";
import { getAdminPreferences } from "@/lib/admin-preferences";
import { DEFAULT_PREFERENCES } from "@/lib/admin-preferences-types";
import { readDbEnvFromCookie, isDevDbConfigured } from "@/lib/db-env";
import { readTzCookie } from "@/lib/timezone/server";
import { resolveAppAccess } from "@/lib/app-access";

// scroll-to-top island lives in the (admin) group; reused 1:1 here. The
// (pack-studio) and (admin) route groups are sibling directories on disk,
// so this relative path resolves across the group boundary.
import { ScrollToTopOnNav } from "../../(admin)/scroll-to-top-on-nav";
import { PageTransition } from "@/components/page-transition";
import { PackStudioSidebar } from "./_components/pack-studio-sidebar";

/**
 * Pack Studio layout — the dedicated route segment that renders Pack Studio
 * as an "app inside the app". It reuses the SAME shell geometry + providers
 * as the main admin layout (`src/app/(admin)/layout.tsx`) — SidebarProvider /
 * SidebarInset, TimezoneProvider, the AdminHeader, the right-rail docks — but
 * swaps in the `PackStudioSidebar` instead of the main `AppSidebar`, so the
 * user enters a visually distinct sub-app while every auth / session / theme
 * provider keeps working unchanged.
 *
 * ACCESS: gated via `canAccessPackStudio` (owners, admins, and Pack Builders).
 * Non-eligible viewers redirect to their landing route. The workspace
 * switcher uses the same rule server-side.
 *
 * The resilient loaders below mirror the main layout's defensive reads so a
 * transient admin-DB fault degrades to safe fallbacks instead of
 * white-screening the sub-app shell.
 */

async function loadHeaderProfile(userId: string): Promise<{
  displayUsername: string | null;
  hasAvatar: boolean;
  email: string;
  profileFieldsAvailable: boolean;
}> {
  try {
    const row = (
      await adminDrizzle.execute<{
        display_username: string | null;
        profile_image_mime: string | null;
        email: string;
      }>(sql`
        SELECT display_username, profile_image_mime, email
        FROM admin_users WHERE id = ${userId}::uuid
      `)
    ).rows[0];
    return {
      displayUsername: row?.display_username ?? null,
      hasAvatar: Boolean(row?.profile_image_mime),
      email: row?.email ?? "",
      profileFieldsAvailable: true,
    };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const missingColumn =
      code === "42703" ||
      (err instanceof Error && /column .* does not exist/i.test(err.message));
    if (missingColumn) {
      try {
        const row = (
          await adminDrizzle.execute<{ email: string }>(sql`
            SELECT email FROM admin_users WHERE id = ${userId}::uuid
          `)
        ).rows[0];
        return {
          displayUsername: null,
          hasAvatar: false,
          email: row?.email ?? "",
          profileFieldsAvailable: false,
        };
      } catch (inner) {
        console.error("[pack-studio-layout] loadHeaderProfile email fallback failed:", inner);
      }
    }
    console.error("[pack-studio-layout] loadHeaderProfile failed:", err);
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
    unstable_rethrow(err);
    console.error("[pack-studio-layout] loadUserPermissions failed:", err);
    return [];
  }
}

async function loadPreferences(userId: string) {
  try {
    return await getAdminPreferences(userId);
  } catch (err) {
    unstable_rethrow(err);
    console.error("[pack-studio-layout] loadPreferences failed:", err);
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * Resilient session verify — identical contract to the main layout's:
 * cookie-missing / expired → redirect to /login; a transient DB fault on the
 * role/active re-read falls back to the signed JWT payload so a blip doesn't
 * tear down the whole sub-app.
 */
async function safeVerifySession(): Promise<SessionPayload> {
  try {
    return await verifySession();
  } catch (err) {
    unstable_rethrow(err);
    console.error(
      "[pack-studio-layout] safeVerifySession DB lookup failed, falling back to JWT:",
      err,
    );
    const session = await getSession();
    if (!session) redirect("/login");
    if (new Date(session.expiresAt) < new Date()) redirect("/login");
    const roles = getEffectiveRoles(session.role, session.roles);
    return { ...session, roles };
  }
}

export default async function PackStudioLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await safeVerifySession();

  // PERF (R3): every remaining layout read is STARTED here, in ONE parallel
  // wave immediately after the session resolves — previously the access-gate
  // pair and the shell reads ran as two further serial admin-DB waves (4
  // round-trip waves total before any pixel). Kicking all of them off
  // together collapses that to session → one parallel wave. All of these
  // loaders resolve (never reject): each catches non-control-flow errors
  // internally and returns a safe fallback, so leaving them in flight on the
  // deny/redirect path below cannot produce an unhandled rejection.
  const profileP = loadHeaderProfile(session.userId);
  const preferencesP = loadPreferences(session.userId);
  const dbEnvP = readDbEnvFromCookie();
  const tzCookieP = readTzCookie();
  const appAccessP = resolveAppAccess(session);

  // Studio access gate: owners, admins, and Pack Builders enter. Everyone
  // else is redirected to the normal landing route for their assigned roles.
  //
  // SECURITY: the gate is decided before any JSX is returned. The other reads
  // merely run concurrently; nothing renders or reaches the client until this
  // check passes. On denial the in-flight reads are
  // discarded (they are the viewer's OWN profile/prefs/permission rows — the
  // same rows the main (admin) shell reads for them anyway).
  const roles = sessionRoles(session);
  if (!canAccessPackStudio(session)) {
    const allowedPages = await loadUserPermissions(session.userId);
    redirect(getDefaultRouteForRoles(roles, allowedPages));
  }

  const [profile, preferences, dbEnv, tzCookie, appAccess] = await Promise.all([
    profileP,
    preferencesP,
    dbEnvP,
    tzCookieP,
    appAccessP,
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
        {/* The swapped nav — Pack Studio's own sidebar replaces AppSidebar.
            `isOwner` reveals the owner-only History entry; `isRetuneOperator`
            reveals the Drafts staging surface (owners + demee). Both pages
            are gated server-side, so hiding the link just avoids a click
            that would bounce. */}
        <PackStudioSidebar
          isOwner={isOwner(session)}
          isRetuneOperator={isPackStudioRetuneOperator(session)}
          access={appAccess}
        />
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
                creator-hub shells so sub-app switches feel coherent. Keys on
                pathname only (in-page ?tab=/?period= don't re-animate); wraps
                the outer content so Suspense fallbacks still stream; no layout
                shift; reduced-motion → instant final state. */}
            <PageTransition>{children}</PageTransition>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TimezoneProvider>
  );
}
