import { Suspense } from "react";
import { SidebarProvider, SidebarInset } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { AdminHeader } from "@/components/admin-header";
import { TopProgressBar } from "@/components/top-progress-bar";
import {
  TopbarHouseStats,
  TopbarHouseStatsSkeleton,
} from "@/components/topbar-house-stats";
import { DockedChat } from "@/components/docked-chat";
import { DockedRecentActivity } from "@/components/docked-recent-activity";
import { LiveMoneyChat } from "@/components/live-money-chat";
import { RightRailProvider } from "@/components/right-rail-context";
import { CommandPalette } from "@/components/command-palette";
import { TimezoneProvider } from "@/components/timezone-provider";
import { redirect } from "next/navigation";
import { verifySession, getUserPermissions } from "@/lib/dal";
import { getSession, type SessionPayload } from "@/lib/session";
import { getEffectiveRoles } from "@/lib/admin-roles";
import { adminDb } from "@/lib/admin-db";
import { getAdminPreferences } from "@/lib/admin-preferences";
import { DEFAULT_PREFERENCES } from "@/lib/admin-preferences-types";
import { readDbEnvFromCookie, isDevDbConfigured } from "@/lib/db-env";
import { readTzCookie } from "@/lib/timezone/server";
import { DevDbBanner } from "@/components/dev-db-banner";
import { isNextControlFlowError } from "@/lib/utils/action-error";

/**
 * Read the optional profile fields. This runs on every admin page load,
 * so failures here crash the entire admin shell (including /settings,
 * /dashboard, everything). Any error — missing column/table, DB
 * unreachable, timeout, unexpected shape — falls back to null values so
 * the header just shows the username + initials instead of tearing
 * down the whole layout. The error is still logged so ops can see it.
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
    console.error("[admin-layout] loadHeaderProfile failed:", err);
    return { displayUsername: null, hasAvatar: false };
  }
}

/**
 * Resilient read of `getUserPermissions` for the layout. A transient
 * adminDb failure (connection blip, statement timeout) here would otherwise
 * crash the entire admin shell — which is exactly the failure mode
 * /dashboard, /cards, /packs hit in prod after the page-body queries were
 * already hardened with safeQuery. Falling back to an empty allow-list is
 * conservative: non-admins effectively see a stripped sidebar and the
 * page's own `requirePageAccess` gate decides whether to redirect; admins
 * (`session.role === "admin"`) bypass the list entirely so the empty array
 * has no effect on them. `redirect()` and `notFound()` signals from inside
 * the call are RE-THROWN so Next can complete the navigation.
 */
async function loadUserPermissions(userId: string): Promise<string[]> {
  try {
    return await getUserPermissions(userId);
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error("[admin-layout] loadUserPermissions failed:", err);
    return [];
  }
}

/**
 * Resilient read of `getAdminPreferences` for the layout. The preferences
 * column already self-heals for the unapplied-migration case (P2022), but
 * any OTHER throw — connection drop, timeout, unexpected shape — would
 * propagate past the layout and white-screen the shell. Falling back to
 * DEFAULT_PREFERENCES keeps the timezone provider's safe defaults so the
 * page still renders; the admin just sees the system theme + browser-
 * detected timezone until the next request recovers.
 */
async function loadPreferences(userId: string) {
  try {
    return await getAdminPreferences(userId);
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error("[admin-layout] loadPreferences failed:", err);
    return { ...DEFAULT_PREFERENCES };
  }
}

/**
 * Resilient wrapper around `verifySession()`. The session check itself is
 * cookie-only (cheap, can't throw for connectivity reasons), but the
 * DB-side `is_active` / role re-read inside it can throw if adminDb has a
 * transient fault — which would otherwise crash the entire admin shell at
 * its very first await (the layout's gate). On a non-control-flow DB
 * failure we fall back to the JWT payload alone: it was signed at login,
 * so the user IS authenticated; the DB refresh only exists to surface
 * stale role state. A few seconds of stale role data is the right trade
 * vs white-screening every page. Cookie-missing / expired redirects are
 * preserved verbatim.
 */
async function safeVerifySession(): Promise<SessionPayload> {
  try {
    return await verifySession();
  } catch (err) {
    if (isNextControlFlowError(err)) throw err;
    console.error(
      "[admin-layout] safeVerifySession DB lookup failed, falling back to JWT:",
      err,
    );
    const session = await getSession();
    if (!session) redirect("/login");
    if (new Date(session.expiresAt) < new Date()) redirect("/login");
    // The JWT carries `role` always; `roles` was added with multi-role and
    // older cookies may omit it. Mirror verifySession's normalization so
    // every downstream consumer sees a consistent shape.
    const roles = getEffectiveRoles(session.role, session.roles);
    return { ...session, roles };
  }
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await safeVerifySession();
  // Permissions, header profile, preferences, and the current DB env
  // are independent lookups keyed on the same userId/cookie jar.
  // Serializing them cost ~4 round-trips on every admin page load —
  // Promise.all collapses them into one.
  //
  // Every entry is wrapped by a layout-local helper that catches non-
  // control-flow errors and returns a safe fallback so a transient
  // adminDb fault can't take the whole admin shell down (the failure mode
  // that white-screened /dashboard, /cards, /packs in prod after their
  // page-body queries were already hardened with safeQuery). Each wrapper
  // re-throws `redirect()` / `notFound()` so navigation still works.
  const [allowedPages, profile, preferences, dbEnv, tzCookie] =
    await Promise.all([
      loadUserPermissions(session.userId),
      loadHeaderProfile(session.userId),
      loadPreferences(session.userId),
      readDbEnvFromCookie(),
      // Browser-detected zone from the `admin_tz` cookie. Passed to the
      // TimezoneProvider so its first client paint matches this SSR render
      // (no hydration flash) when the admin has no explicit pref. readTzCookie
      // never throws (background-ctx safe) and returns null when absent.
      readTzCookie(),
    ]);
  // Only surface the switcher to admins on servers where a dev DB is
  // actually configured; otherwise the toggle would be a dead option.
  const canSwitchDbEnv = session.role === "admin" && isDevDbConfigured();

  // Chat/mutes panel is only surfaced to users who could reach the old
  // /chat page — keeps the same permission boundary as the removed route.
  const canOpenChatPanel =
    session.role === "admin" || allowedPages.includes("/chat");

  return (
    <TimezoneProvider
      initialTimezone={preferences.timezone}
      cookieTimezone={tzCookie}
      initialDateFormat={preferences.dateFormat}
    >
      <SidebarProvider>
        {/* Suspense wrapper is required — TopProgressBar uses useSearchParams
            which suspends during SSR. Nothing to render while it suspends. */}
        <Suspense fallback={null}>
          <TopProgressBar />
        </Suspense>
        <AppSidebar
          role={session.role}
          roles={session.roles ?? [session.role]}
          allowedPages={allowedPages}
          username={session.username}
          dbEnv={dbEnv}
        />
        {/* SidebarInset is the shadcn shell partner to <Sidebar> — it's the
            <main> landmark that flexes to fill the space beside the sidebar
            and (in inset variants) gets the rounded/elevated treatment. We
            keep the existing default ("sidebar") variant, so visually this is
            the same full-bleed column the old plain <div> produced, just
            wired through the primitive so the sidebar/inset geometry (gap,
            collapse width) is owned in one place. `min-w-0` is preserved so
            flex children (wide tables/charts) can shrink instead of forcing
            the whole shell to scroll horizontally. */}
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
            // Admin-only top-bar house pills (all-time wager/deposit/
            // withdrawal/GGR). Reuses the dashboard's 5-min-cached balances
            // aggregate (no new query), and is wrapped in its OWN Suspense
            // boundary so it streams independently and never blocks the
            // header/shell — a slow read shows skeleton pills, then "—" on
            // failure. Rendered only for the `admin` role; every other role
            // sees the bar unchanged.
            houseStatsSlot={
              session.role === "admin" ? (
                <Suspense
                  // The skeleton pills otherwise pop in from blank the
                  // instant this boundary mounts. Wrapping the fallback in a
                  // soft fade-in (tw-animate-css, the same `animate-in
                  // fade-in` the house motion system uses) eases them in
                  // rather than hard-cutting. `motion-safe:` only — reduced-
                  // motion users land on the final state with no tween. The
                  // wrapper mirrors the skeleton's own `hidden md:flex`
                  // breakpoint (`hidden md:block`) so it stays display:none
                  // below md — no phantom flex-gap next to the avatar on
                  // phones — and is only a real (animatable) box at md+ where
                  // the pills actually show. The real stats replace it,
                  // unwrapped, once they stream in.
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
          {/* Scrollable content region. This used to be a <main>, but the
              SidebarInset wrapper above is now the page's single <main>
              landmark, so this is a plain <div> (nesting <main> in <main> is
              invalid). `min-w-0` is required so flex children can shrink below
              their intrinsic content width — without it, a wide table or chart
              forces the entire shell to scroll horizontally instead of just
              the offending element. `pb-[env(safe-area-inset-bottom)]` gives
              iOS notched devices breathing room above the home bar. */}
          <div
            className="flex-1 overflow-auto min-w-0 p-3 sm:p-4 md:p-6 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-[max(1rem,env(safe-area-inset-bottom))] md:pb-[max(1.5rem,env(safe-area-inset-bottom))]"
          >
            {children}
          </div>
        </SidebarInset>
        <CommandPalette role={session.role} allowedPages={allowedPages} />
        {/* Right-edge docked widgets — three slots, top → bottom:
              • LiveMoneyChat       (top)    deposits + withdrawals feed
              • DockedRecentActivity (middle) signups + wagers + payouts feed
              • DockedChat           (bottom) Chat & Mutes panel
            All three are persistent, collapsible, and state-tracked via
            the shared right-rail context. At most TWO may be expanded at
            the same time — opening a third auto-collapses the oldest-
            opened one (FIFO eviction inside RightRailProvider). The
            chat dock is permission-gated to the same boundary the old
            /chat page used; the live + recent docks are visible to
            every admin user. `mounted={{ chat }}` tells the rail
            geometry whether to reserve space for chat — without it the
            non-admin shell would leave a 5rem empty band at the bottom. */}
        <RightRailProvider mounted={{ chat: canOpenChatPanel }}>
          <LiveMoneyChat />
          <DockedRecentActivity />
          {canOpenChatPanel && <DockedChat role={session.role} />}
        </RightRailProvider>
      </SidebarProvider>
    </TimezoneProvider>
  );
}
