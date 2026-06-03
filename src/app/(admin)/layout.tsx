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
import { verifySession, getUserPermissions } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";
import { getAdminPreferences } from "@/lib/admin-preferences";
import { readDbEnvFromCookie, isDevDbConfigured } from "@/lib/db-env";
import { DevDbBanner } from "@/components/dev-db-banner";

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

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await verifySession();
  // Permissions, header profile, preferences, and the current DB env
  // are independent lookups keyed on the same userId/cookie jar.
  // Serializing them cost ~4 round-trips on every admin page load —
  // Promise.all collapses them into one.
  const [allowedPages, profile, preferences, dbEnv] = await Promise.all([
    getUserPermissions(session.userId),
    loadHeaderProfile(session.userId),
    getAdminPreferences(session.userId),
    readDbEnvFromCookie(),
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
                <Suspense fallback={<TopbarHouseStatsSkeleton />}>
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
