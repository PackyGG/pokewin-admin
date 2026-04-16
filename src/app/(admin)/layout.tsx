import { Suspense } from "react";
import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { AdminHeader } from "@/components/admin-header";
import { TopProgressBar } from "@/components/top-progress-bar";
import { verifySession, getUserPermissions } from "@/lib/dal";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await verifySession();
  const allowedPages = await getUserPermissions(session.userId);

  return (
    <SidebarProvider>
      {/* Suspense wrapper is required — TopProgressBar uses useSearchParams
          which suspends during SSR. Nothing to render while it suspends. */}
      <Suspense fallback={null}>
        <TopProgressBar />
      </Suspense>
      <AppSidebar role={session.role} allowedPages={allowedPages} />
      <div className="flex flex-1 flex-col">
        <AdminHeader username={session.username} role={session.role} />
        <main className="flex-1 overflow-auto p-4 md:p-6">{children}</main>
      </div>
    </SidebarProvider>
  );
}
