import { Suspense } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { AdminHeader } from "@/components/admin-header";
import { TopProgressBar } from "@/components/top-progress-bar";
import { ChatPanel } from "@/components/chat-panel/chat-panel";
import { verifySession, getUserPermissions } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";

/**
 * Read the optional profile fields. Safe against the migration not having
 * run yet — returns nulls in that case so the header falls back gracefully.
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
    const code = (err as { code?: string })?.code;
    const missingColumn =
      code === "P2022" ||
      (err instanceof Error && /column .* does not exist/i.test(err.message));
    if (missingColumn) return { displayUsername: null, hasAvatar: false };
    throw err;
  }
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await verifySession();
  const allowedPages = await getUserPermissions(session.userId);
  const profile = await loadHeaderProfile(session.userId);

  // Chat/mutes panel is only surfaced to users who could reach the old
  // /chat page — keeps the same permission boundary as the removed route.
  const canOpenChatPanel =
    session.role === "admin" || allowedPages.includes("/chat");

  return (
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
      {canOpenChatPanel && <ChatPanel role={session.role} />}
    </SidebarProvider>
  );
}
