import { Suspense } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { AdminHeader } from "@/components/admin-header";
import { TopProgressBar } from "@/components/top-progress-bar";
import { DockedChat } from "@/components/docked-chat";
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
          allowedPages={allowedPages}
          username={session.username}
          dbEnv={dbEnv}
        />
        <div className="flex flex-1 flex-col min-w-0">
          {dbEnv === "dev" && <DevDbBanner />}
          <AdminHeader
            adminId={session.userId}
            username={session.username}
            displayUsername={profile.displayUsername}
            hasAvatar={profile.hasAvatar}
            role={session.role}
            dbEnv={dbEnv}
            canSwitchDbEnv={canSwitchDbEnv}
          />
          {/* `min-w-0` is required so flex children can shrink below their
              intrinsic content width — without it, a wide table or chart
              forces the entire shell to scroll horizontally instead of
              just the offending element. `pb-[env(safe-area-inset-bottom)]`
              gives iOS notched devices breathing room above the home bar. */}
          <main
            className="flex-1 overflow-auto min-w-0 p-3 sm:p-4 md:p-6 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-[max(1rem,env(safe-area-inset-bottom))] md:pb-[max(1.5rem,env(safe-area-inset-bottom))]"
          >
            {children}
          </main>
        </div>
        <CommandPalette role={session.role} allowedPages={allowedPages} />
        {/* Right-edge docked widgets. LiveMoneyChat (top half) streams
            deposits + withdrawals across every admin page; DockedChat
            (bottom half) holds the platform Chat & Mutes feed. Both
            are persistent, collapsible, and independently
            state-tracked via the shared right-rail context — when the
            admin collapses the live feed, the chat dock slides up to
            fill the freed space, and vice versa. The chat dock is
            permission-gated to the same boundary the old /chat page
            used. */}
        <RightRailProvider>
          <LiveMoneyChat />
          {canOpenChatPanel && <DockedChat role={session.role} />}
        </RightRailProvider>
      </SidebarProvider>
    </TimezoneProvider>
  );
}
