import { Suspense } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { AdminHeader } from "@/components/admin-header";
import { TopProgressBar } from "@/components/top-progress-bar";
import { ChatPanel } from "@/components/chat-panel/chat-panel";
import { CommandPalette } from "@/components/command-palette";
import { TimezoneProvider } from "@/components/timezone-provider";
import { verifySession, getUserPermissions } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";
import { getAdminPreferences } from "@/lib/admin-preferences";

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
  // Permissions, header profile, and preferences are independent lookups
  // keyed on the same userId. Serializing them cost ~3 round-trips on
  // every admin page load — Promise.all collapses them into one.
  const [allowedPages, profile, preferences] = await Promise.all([
    getUserPermissions(session.userId),
    loadHeaderProfile(session.userId),
    getAdminPreferences(session.userId),
  ]);

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
        <AppSidebar role={session.role} allowedPages={allowedPages} />
        <div className="flex flex-1 flex-col">
          <AdminHeader
            adminId={session.userId}
            username={session.username}
            displayUsername={profile.displayUsername}
            hasAvatar={profile.hasAvatar}
            role={session.role}
          />
          <main className="flex-1 overflow-auto p-4 md:p-6">{children}</main>
        </div>
        <CommandPalette role={session.role} allowedPages={allowedPages} />
        {canOpenChatPanel && <ChatPanel role={session.role} />}
      </SidebarProvider>
    </TimezoneProvider>
  );
}
