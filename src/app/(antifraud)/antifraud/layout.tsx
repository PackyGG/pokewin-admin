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
  canAccessAntifraud,
  canManageAntifraud,
  deniedAntifraudSettings,
  getAntifraudAccessSettings,
  getAntifraudUserAccess,
  type AntifraudAccessSettings,
  type AntifraudUserAccess,
} from "@/lib/antifraud/access";
import { ensureStaffProfile } from "@/lib/antifraud/profile";
import { adminDb } from "@/lib/admin-db";
import { getAdminPreferences } from "@/lib/admin-preferences";
import { DEFAULT_PREFERENCES } from "@/lib/admin-preferences-types";
import { readDbEnvFromCookie, isDevDbConfigured } from "@/lib/db-env";
import { readTzCookie } from "@/lib/timezone/server";
import { isNextControlFlowError } from "@/lib/utils/action-error";

// scroll-to-top island lives in the (admin) group; reused 1:1 here. The
// (antifraud) and (admin) route groups are sibling directories on disk, so this
// relative path resolves across the group boundary.
import { ScrollToTopOnNav } from "../../(admin)/scroll-to-top-on-nav";
import { PageTransition } from "@/components/page-transition";
import { AntifraudSidebar } from "./_components/antifraud-sidebar";

/**
 * Antifraud layout — the THIRD "app inside the app", after Creator Hub and Pack
 * Studio. It reuses the SAME shell geometry + providers as the main admin
 * layout (`src/app/(admin)/layout.tsx`) — SidebarProvider / SidebarInset,
 * TimezoneProvider, the AdminHeader (with its notification bell), the right-rail
 * scaffolding — but swaps in the `AntifraudSidebar`, so the user enters a
 * visually distinct sub-app while every auth / session / theme provider keeps
 * working unchanged.
 *
 * It is ALSO the app served at `fraud.packydash.com`: the middleware rewrites
 * that host's requests into this segment, so the same tree renders from the same
 * build and the same session (see `src/lib/antifraud/host.ts`).
 *
 * ACCESS: gated via `canAccessAntifraud` (owner / admin bypass, a per-username
 * allowlist, or a per-role ADMIN-DB toggle). Non-eligible viewers redirect to
 * their landing route. The "Switch to Antifraud" portal button in the main
 * sidebar uses the same rule server-side, so nobody sees a door they'd bounce
 * off.
 *
 * The resilient loaders below mirror the other shells' defensive reads so a
 * transient admin-DB fault degrades to safe fallbacks instead of white-screening
 * the sub-app.
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
        console.error(
          "[antifraud-layout] loadHeaderProfile email fallback failed:",
          inner,
        );
      }
    }
    console.error("[antifraud-layout] loadHeaderProfile failed:", err);
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
    console.error("[antifraud-layout] loadUserPermissions failed:", err);
    return [];
  }
}

/**
 * Resilient read of the per-role access toggles. A transient admin-DB fault
 * must NOT silently widen access, so any failure degrades to every toggle OFF
 * (fail-closed) — only the owner/admin bypass in `canAccessAntifraud` survives
 * a DB blip, which is the safe outcome for a security gate.
 */
async function loadAccessSettings(): Promise<AntifraudAccessSettings> {
  try {
    return await getAntifraudAccessSettings();
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error(
      "[antifraud-layout] loadAccessSettings failed, denying toggle-based access:",
      err,
    );
    return deniedAntifraudSettings();
  }
}

/** Per-username override read — falls back to the role default on failure. */
async function loadUserAccess(): Promise<AntifraudUserAccess> {
  try {
    return await getAntifraudUserAccess();
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error(
      "[antifraud-layout] loadUserAccess failed, falling back to role default:",
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
    console.error("[antifraud-layout] loadPreferences failed:", err);
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * Resilient session verify — identical contract to the other shells':
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
      "[antifraud-layout] safeVerifySession DB lookup failed, falling back to JWT:",
      err,
    );
    const session = await getSession();
    if (!session) redirect("/login");
    if (new Date(session.expiresAt) < new Date()) redirect("/login");
    const roles = getEffectiveRoles(session.role, session.roles);
    return { ...session, roles };
  }
}

export default async function AntifraudLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await safeVerifySession();

  // Every remaining layout read is STARTED here, in ONE parallel wave right
  // after the session resolves, so the shell costs session → one wave rather
  // than four serial admin-DB round-trips. All of these loaders resolve (never
  // reject): each catches non-control-flow errors internally and returns a safe
  // fallback, so leaving them in flight on the deny/redirect path below cannot
  // produce an unhandled rejection.
  const accessSettingsP = loadAccessSettings();
  const userAccessP = loadUserAccess();
  const allowedPagesP = loadUserPermissions(session.userId);
  const profileP = loadHeaderProfile(session.userId);
  const preferencesP = loadPreferences(session.userId);
  const dbEnvP = readDbEnvFromCookie();
  const tzCookieP = readTzCookie();
  const railOpenOrderP = readRailOpenOrder();

  // Access gate (security-sensitive). It awaits ONLY its own dependencies and
  // is decided BEFORE any JSX is returned — the other reads merely run
  // concurrently; nothing renders and nothing is sent to the client until this
  // check passes.
  const roles = sessionRoles(session);
  const [accessSettings, userAccess] = await Promise.all([
    accessSettingsP,
    userAccessP,
  ]);
  if (!canAccessAntifraud(session, accessSettings, userAccess)) {
    const allowedPages = await allowedPagesP;
    redirect(getDefaultRouteForRoles(roles, allowedPages));
  }

  const [allowedPages, profile, preferences, dbEnv, tzCookie, railOpenOrder] =
    await Promise.all([
      allowedPagesP,
      profileP,
      preferencesP,
      dbEnvP,
      tzCookieP,
      railOpenOrderP,
    ]);

  // First visit into the workspace creates the staff profile + stamps the
  // heartbeat. Deliberately AFTER the access gate (only people who can actually
  // be here get a profile) and non-blocking in effect — it returns null rather
  // than throwing if the tables aren't provisioned on this deployment.
  await ensureStaffProfile(session.userId);

  const canSwitchDbEnv = session.role === "admin" && isDevDbConfigured();
  const canOpenChatPanel =
    session.role === "admin" || allowedPages.includes("/chat");
  const canManage = canManageAntifraud(session);

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
        {/* The swapped nav — Antifraud's own sidebar replaces AppSidebar.
            `canManage` (owner/admin) reveals the quiz-authoring + settings
            group; those pages are gated server-side too, so hiding the links
            just avoids a click that would bounce. */}
        <AntifraudSidebar canManage={canManage} />
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
            {/* Subtle route-enter animation, shared with the main admin,
                creator-hub and pack-studio shells so sub-app switches feel
                coherent. Keys on pathname only; reduced-motion → instant. */}
            <PageTransition>{children}</PageTransition>
          </div>
        </SidebarInset>
        {/* Rail scaffolding only — the live money + recent-activity docks are
            deliberately NOT mounted here (SECURITY_AUDIT.md HIGH-2: customer
            financial activity must not stream to workspace roles). */}
        <RightRailProvider
          mounted={{ chat: canOpenChatPanel }}
          initialOpenOrder={railOpenOrder}
        >
          <RailWidthSync />
        </RightRailProvider>
      </SidebarProvider>
    </TimezoneProvider>
  );
}
