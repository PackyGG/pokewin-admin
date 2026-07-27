import { Suspense } from "react";
import { redirect, unstable_rethrow } from "next/navigation";

import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AdminHeader } from "@/components/admin-header";
import { TopProgressBar } from "@/components/top-progress-bar";
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
import { eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { admin_users } from "@/lib/db-schema/admin/schema";
import { isPostgresError } from "@/lib/postgres-errors";
import { getAdminPreferences } from "@/lib/admin-preferences";
import { DEFAULT_PREFERENCES } from "@/lib/admin-preferences-types";
import { readDbEnvFromCookie, isDevDbConfigured } from "@/lib/db-env";
import { readTzCookie } from "@/lib/timezone/server";
import { resolveAppAccess } from "@/lib/app-access";

// scroll-to-top island lives in the (admin) group; reused 1:1 here. The
// (antifraud) and (admin) route groups are sibling directories on disk, so this
// relative path resolves across the group boundary.
import { ScrollToTopOnNav } from "../../(admin)/scroll-to-top-on-nav";
import { PageTransition } from "@/components/page-transition";
import { AntifraudSidebar } from "./_components/antifraud-sidebar";

/**
 * Antifraud layout â€” the THIRD "app inside the app", after Creator Hub and Pack
 * Studio. It reuses the SAME shell geometry + providers as the main admin
 * layout (`src/app/(admin)/layout.tsx`) â€” SidebarProvider / SidebarInset,
 * TimezoneProvider, the AdminHeader (with its notification bell), the
 * scaffolding â€” but swaps in the `AntifraudSidebar`, so the user enters a
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
    const [row] = await adminDrizzle.select({
      display_username: admin_users.display_username,
      profile_image_mime: admin_users.profile_image_mime,
      email: admin_users.email,
    }).from(admin_users).where(eq(admin_users.id, userId)).limit(1);
    return {
      displayUsername: row?.display_username ?? null,
      hasAvatar: Boolean(row?.profile_image_mime),
      email: row?.email ?? "",
      profileFieldsAvailable: true,
    };
  } catch (err) {
    const missingColumn =
      isPostgresError(err, "42703") ||
      (err instanceof Error && /column .* does not exist/i.test(err.message));
    if (missingColumn) {
      try {
        const [row] = await adminDrizzle.select({ email: admin_users.email })
          .from(admin_users).where(eq(admin_users.id, userId)).limit(1);
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
    unstable_rethrow(err);
    console.error("[antifraud-layout] loadUserPermissions failed:", err);
    return [];
  }
}

/**
 * Resilient read of the per-role access toggles. A transient admin-DB fault
 * must NOT silently widen access, so any failure degrades to every toggle OFF
 * (fail-closed) â€” only the owner/admin bypass in `canAccessAntifraud` survives
 * a DB blip, which is the safe outcome for a security gate.
 */
async function loadAccessSettings(): Promise<AntifraudAccessSettings> {
  try {
    return await getAntifraudAccessSettings();
  } catch (err) {
    unstable_rethrow(err);
    console.error(
      "[antifraud-layout] loadAccessSettings failed, denying toggle-based access:",
      err,
    );
    return deniedAntifraudSettings();
  }
}

/** Per-username override read â€” falls back to the role default on failure. */
async function loadUserAccess(): Promise<AntifraudUserAccess> {
  try {
    return await getAntifraudUserAccess();
  } catch (err) {
    unstable_rethrow(err);
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
    unstable_rethrow(err);
    console.error("[antifraud-layout] loadPreferences failed:", err);
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * Resilient session verify â€” identical contract to the other shells':
 * cookie-missing / expired â†’ redirect to /login; a transient DB fault on the
 * role/active re-read falls back to the signed JWT payload so a blip doesn't
 * tear down the whole sub-app.
 */
async function safeVerifySession(): Promise<SessionPayload> {
  try {
    return await verifySession();
  } catch (err) {
    unstable_rethrow(err);
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
  // after the session resolves, so the shell costs session â†’ one wave rather
  // than four serial admin-DB round-trips. All of these loaders resolve (never
  // reject): each catches non-control-flow errors internally and returns a safe
  // fallback, so leaving them in flight on the deny/redirect path below cannot
  // produce an unhandled rejection.
  const accessSettingsP = loadAccessSettings();
  const userAccessP = loadUserAccess();
  const profileP = loadHeaderProfile(session.userId);
  const preferencesP = loadPreferences(session.userId);
  const dbEnvP = readDbEnvFromCookie();
  const tzCookieP = readTzCookie();
  const appAccessP = resolveAppAccess(session);

  // Access gate (security-sensitive). It awaits ONLY its own dependencies and
  // is decided BEFORE any JSX is returned â€” the other reads merely run
  // concurrently; nothing renders and nothing is sent to the client until this
  // check passes.
  const roles = sessionRoles(session);
  const [accessSettings, userAccess] = await Promise.all([
    accessSettingsP,
    userAccessP,
  ]);
  if (!canAccessAntifraud(session, accessSettings, userAccess)) {
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
        {/* The swapped nav â€” Antifraud's own sidebar replaces AppSidebar.
            `canManage` (owner/admin) reveals antifraud settings. */}
        <AntifraudSidebar canManage={canManage} access={appAccess} />
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
                coherent. Keys on pathname only; reduced-motion â†’ instant. */}
            <PageTransition>{children}</PageTransition>
          </div>
        </SidebarInset>
        {/* Rail scaffolding only — the live money + recent-activity docks are
            deliberately NOT mounted here (SECURITY_AUDIT.md HIGH-2: customer
            financial activity must not stream to workspace roles). */}
      </SidebarProvider>
    </TimezoneProvider>
  );
}
