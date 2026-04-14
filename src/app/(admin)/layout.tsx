import { SidebarProvider } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { AdminHeader } from "@/components/admin-header";
import { verifySession, getUserPermissions } from "@/lib/dal";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await verifySession();
  const allowedPages = await getUserPermissions(session.userId);

  return (
    <SidebarProvider
      // Widen the icon-mode sidebar so the larger buttons (size-10, 40px)
      // have comfortable margins inside the rail. Default is 3rem (48px).
      style={{ "--sidebar-width-icon": "3.75rem" } as React.CSSProperties}
    >
      <AppSidebar role={session.role} allowedPages={allowedPages} />
      <div className="flex flex-1 flex-col">
        <AdminHeader username={session.username} role={session.role} />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </SidebarProvider>
  );
}
