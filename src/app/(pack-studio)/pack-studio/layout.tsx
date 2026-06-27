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
import { RailWidthSync } from "@/components/rail-width-sync";
import { TimezoneProvider } from "@/components/timezone-provider";
import { DevDbBanner } from "@/components/dev-db-banner";

import { verifySession, getUserPermissions, sessionRoles } from "@/lib/dal";
import { getSession, type SessionPayload } from "@/lib/session";
import { getEffectiveRoles, getDefaultRouteForRoles } from "@/lib/admin-roles";
import {
  canAccessPackStudio,
  getPackStudioAccessSettings,
  getPackStudioUserAccess,
  PACK_STUDIO_TOGGLE_ROLES,
  type PackStudioAccessSettings,
  type PackStudioUserAccess,
} from "@/lib/pack-studio-access";
import { adminDb } from "@/lib/admin-db";
import { isOwner } from "@/lib/owners";
import { isPackStudioRetuneOperator } from "@/lib/reprice-access";
import { getAdminPreferences } from "@/lib/admin-preferences";
import { DEFAULT_PREFERENCES } from "@/lib/admin-preferences-types";
import { readDbEnvFromCookie, isDevDbConfigured } from "@/lib/db-env";
import { readTzCookie } from "@/lib/timezone/server";
import { isNextControlFlowError } from "@/lib/utils/action-error";

// scroll-to-top island lives in the (admin) group; reused 1:1 here. The
// (pack-studio) and (admin) route groups are sibling directories on disk,
// so this relative path resolves across the group boundary.
import { ScrollToTopOnNav } from "../../(admin)/scroll-to-top-on-nav";
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
 * ACCESS: gated via `canAccessPackStudio` (owner bypass OR a per-role ADMIN-DB
 * toggle). Non-eligible viewers redirect to their landing route. The "Switch
 * to Pack Studio" portal button uses the same rule server-side.
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
    const row = await adminDb.admin_users.findUnique({
      where: { id: userId },
      select: {
        display_username: true,
        profile_image_mime: true,
        email: true,
      },
    });
    return {
      displayUsername: row?.display_username ?? null,
      hasAvatar: Boolean(row?.profile_image_mime),
      email: row?.email ?? "",
      profileFieldsAvailable: true,
    };
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const missingColumn =
      code === "P2022" ||
      (err instanceof Error && /column .* does not exist/i.test(err.message));
    if (missingColumn) {
      try {
        const row = await adminDb.admin_users.findUnique({
          where: { id: userId },
          select: { email: true },
        });
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
    if (isNextControlFlowError(err)) throw err;
    console.error("[pack-studio-layout] loadUserPermissions failed:", err);
    return [];
  }
}

/**
 * Resilient read of the per-role Pack-Studio access toggles. A transient
 * admin-DB fault must NOT silently widen access, so any failure degrades to
 * every toggle OFF (fail-closed) — only the owner bypass in
 * `canAccessPackStudio` survives a DB blip, which is the safe outcome for a
 * security gate.
 */
async function loadPackStudioAccessSettings(): Promise<PackStudioAccessSettings> {
  try {
    return await getPackStudioAccessSettings();
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error(
      "[pack-studio-layout] loadPackStudioAccessSettings failed, denying non-owner access:",
      err,
    );
    return Object.fromEntries(
      PACK_STUDIO_TOGGLE_ROLES.map((role) => [role, false]),
    ) as PackStudioAccessSettings;
  }
}

/**
 * Per-username allow/deny override read. On error we fall back to empty
 * lists (= role-based default), which keeps owners in (their bypass is
 * DB-independent) and admins in (their role default still passes) — the
 * safest middle ground when the override read blips.
 */
async function loadPackStudioUserAccess(): Promise<PackStudioUserAccess> {
  try {
    return await getPackStudioUserAccess();
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error(
      "[pack-studio-layout] loadPackStudioUserAccess failed, falling back to role default:",
      err,
    );
    return { allowlist: [], denylist: [] };
  }
}

async function loadPreferences(userId: string) {
  try {
    return await getAdminPreferences(userId);
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
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
    if (isNextControlFlowError(err)) throw err;
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

  // Studio access gate (security-sensitive): an owner OR a per-role toggle
  // (ADMIN DB, default OFF) enabled for one of the viewer's effective roles —
  // see `canAccessPackStudio`. With the toggle off ONLY owners reach the
  // Studio; everyone else (incl. non-owner admins) is bounced to their normal
  // landing route. We resolve the redirect the same way the DAL does so a
  // non-eligible user lands somewhere they can actually use.
  const roles = sessionRoles(session);
  const [studioAccessSettings, studioUserAccess] = await Promise.all([
    loadPackStudioAccessSettings(),
    loadPackStudioUserAccess(),
  ]);
  if (!canAccessPackStudio(session, studioAccessSettings, studioUserAccess)) {
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
        {/* The swapped nav — Pack Studio's own sidebar replaces AppSidebar.
            `isOwner` reveals the owner-only History entry; `isRetuneOperator`
            reveals the Drafts staging surface (owners + demee). Both pages
            are gated server-side, so hiding the link just avoids a click
            that would bounce. */}
        <PackStudioSidebar
          isOwner={isOwner(session)}
          isRetuneOperator={isPackStudioRetuneOperator(session)}
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
            recent activity stay available inside the Studio. Chat dock is
            gated to the same permission boundary as the main layout. */}
        <RightRailProvider mounted={{ chat: canOpenChatPanel }}>
          <RailWidthSync />
          <LiveMoneyChat />
          <DockedRecentActivity />
        </RightRailProvider>
      </SidebarProvider>
    </TimezoneProvider>
  );
}
