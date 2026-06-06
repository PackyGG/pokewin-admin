import { Suspense } from "react";
import { redirect } from "next/navigation";

import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AdminHeader } from "@/components/admin-header";
import { TopProgressBar } from "@/components/top-progress-bar";
import {
  TopbarHouseStats,
  TopbarHouseStatsSkeleton,
} from "@/components/topbar-house-stats";
import { DockedRecentActivity } from "@/components/docked-recent-activity";
import { LiveMoneyChat } from "@/components/live-money-chat";
import { RightRailProvider } from "@/components/right-rail-context";
import { TimezoneProvider } from "@/components/timezone-provider";
import { DevDbBanner } from "@/components/dev-db-banner";

import { verifySession, getUserPermissions, sessionRoles } from "@/lib/dal";
import { getSession, type SessionPayload } from "@/lib/session";
import { getEffectiveRoles, getDefaultRouteForRoles } from "@/lib/admin-roles";
import { adminDb } from "@/lib/admin-db";
import { getAdminPreferences } from "@/lib/admin-preferences";
import { DEFAULT_PREFERENCES } from "@/lib/admin-preferences-types";
import { readDbEnvFromCookie, isDevDbConfigured } from "@/lib/db-env";
import { readTzCookie } from "@/lib/timezone/server";
import { isNextControlFlowError } from "@/lib/utils/action-error";

// scroll-to-top island lives in the (admin) group; reused 1:1 here. The
// (creator-hub) and (admin) route groups are sibling directories on disk,
// so this relative path resolves across the group boundary.
import { ScrollToTopOnNav } from "../../(admin)/scroll-to-top-on-nav";
import { CreatorHubSidebar } from "./_components/creator-hub-sidebar";

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
 * ACCESS: gated to `admin` + `creator_manager` ONLY via the DAL. A user
 * without either role is redirected to their normal landing route — they
 * never see the Hub. (This is the route-level enforcement; the "Switch to
 * Creator Hub" portal button in the main sidebar is gated to the same set
 * cosmetically.)
 *
 * The resilient loaders below mirror the main layout's defensive reads so
 * a transient admin-DB fault degrades to safe fallbacks instead of
 * white-screening the sub-app shell.
 */

async function loadHeaderProfile(userId: string): Promise<{
  displayUsername: string | null;
  hasAvatar: boolean;
}> {
  try {
    const row = await adminDb.admin_users.findUnique({
      where: { id: userId },
      select: { display_username: true, profile_image_mime: true },
    });
    return {
      displayUsername: row?.display_username ?? null,
      hasAvatar: Boolean(row?.profile_image_mime),
    };
  } catch (err) {
    console.error("[creator-hub-layout] loadHeaderProfile failed:", err);
    return { displayUsername: null, hasAvatar: false };
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

  // Hub access gate: admin OR creator_manager only. Everyone else is
  // bounced to their normal landing route. (We resolve the redirect target
  // the same way the DAL does so a non-eligible user lands somewhere they
  // can actually use, rather than a generic page.)
  const roles = sessionRoles(session);
  const canEnter =
    roles.includes("admin") || roles.includes("creator_manager");
  if (!canEnter) {
    const allowedPages = await loadUserPermissions(session.userId);
    redirect(getDefaultRouteForRoles(roles, allowedPages));
  }

  const [allowedPages, profile, preferences, dbEnv, tzCookie] =
    await Promise.all([
      loadUserPermissions(session.userId),
      loadHeaderProfile(session.userId),
      loadPreferences(session.userId),
      readDbEnvFromCookie(),
      readTzCookie(),
    ]);

  const canSwitchDbEnv = session.role === "admin" && isDevDbConfigured();
  const canOpenChatPanel =
    session.role === "admin" || allowedPages.includes("/chat");

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
        <CreatorHubSidebar />
        <SidebarInset className="min-w-0">
          {dbEnv === "dev" && <DevDbBanner />}
          <AdminHeader
            adminId={session.userId}
            username={session.username}
            displayUsername={profile.displayUsername}
            hasAvatar={profile.hasAvatar}
            role={session.role}
            roles={session.roles ?? [session.role]}
            dbEnv={dbEnv}
            canSwitchDbEnv={canSwitchDbEnv}
            houseStatsSlot={
              session.role === "admin" ? (
                <Suspense
                  fallback={
                    <div className="hidden md:block motion-safe:animate-in motion-safe:fade-in">
                      <TopbarHouseStatsSkeleton />
                    </div>
                  }
                >
                  <TopbarHouseStats />
                </Suspense>
              ) : undefined
            }
          />
          <div
            data-admin-scroll
            className="flex-1 overflow-auto min-w-0 p-3 sm:p-4 md:p-6 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-[max(1rem,env(safe-area-inset-bottom))] md:pb-[max(1.5rem,env(safe-area-inset-bottom))]"
          >
            <ScrollToTopOnNav />
            {children}
          </div>
        </SidebarInset>
        {/* Right-edge docks — reused 1:1 from the main shell so live money /
            recent activity stay available inside the Hub. Chat dock is
            gated to the same permission boundary as the main layout. */}
        <RightRailProvider mounted={{ chat: canOpenChatPanel }}>
          <LiveMoneyChat />
          <DockedRecentActivity />
        </RightRailProvider>
      </SidebarProvider>
    </TimezoneProvider>
  );
}
