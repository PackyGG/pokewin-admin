import Link from "next/link";
import { Shield, CheckCircle2, XCircle, ShieldCheck } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils/format";
import { AdminUserActions } from "./admin-user-actions";
import { CreateAdminDialog } from "./create-dialog";
import {
  PageHero,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Admin Users" };

export default async function AdminUsersPage() {
  await requirePageAccess("/admin-users");

  const users = await adminDb.admin_users.findMany({
    orderBy: { created_at: "desc" },
  });

  const activeCount = users.filter((u) => u.is_active).length;
  const totpCount = users.filter((u) => u.totp_enabled).length;
  const inactiveCount = users.length - activeCount;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
              <Shield className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">Admin Users</h1>
              <p className="text-sm text-muted-foreground">
                Staff accounts — roles, 2FA status, and activation state.
              </p>
            </div>
          </div>
          <CreateAdminDialog />
        </div>
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile
          label="Total Admins"
          value={String(users.length)}
          icon={Shield}
          accent="blue"
        />
        <KpiTile
          label="Active"
          value={String(activeCount)}
          icon={CheckCircle2}
          accent="emerald"
        />
        <KpiTile
          label="Inactive"
          value={String(inactiveCount)}
          icon={XCircle}
          accent="rose"
        />
        <KpiTile
          label="2FA Enabled"
          value={String(totpCount)}
          icon={ShieldCheck}
          accent="purple"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Shield} title="All Admins" />
        <FadeIn className="rounded-md border overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left text-sm font-medium">Username</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Email</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Role</th>
                <th className="px-4 py-3 text-left text-sm font-medium">2FA</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Status</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Created</th>
                <th className="px-4 py-3 text-right text-sm font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-b last:border-b-0">
                  <td className="px-4 py-3 text-sm font-medium">
                    <Link
                      href={`/admin-users/${user.id}`}
                      className="text-blue-400 hover:underline"
                    >
                      {user.username}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {user.email}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className="text-xs uppercase">
                      {user.role}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant="outline"
                      className={
                        user.totp_enabled
                          ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
                          : "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30"
                      }
                    >
                      {user.totp_enabled ? "Enabled" : "Not set up"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant="outline"
                      className={
                        user.is_active
                          ? "bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30"
                          : "bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/30"
                      }
                    >
                      {user.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {formatDateTime(user.created_at.toISOString())}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <AdminUserActions
                      userId={user.id}
                      isActive={user.is_active}
                      totpEnabled={user.totp_enabled}
                      role={user.role}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </FadeIn>
      </div>
    </div>
  );
}
