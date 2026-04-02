import Link from "next/link";
import { requirePageAccess } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils/format";
import { AdminUserActions } from "./admin-user-actions";
import { CreateAdminDialog } from "./create-dialog";

export default async function AdminUsersPage() {
  await requirePageAccess("/admin-users");

  const users = await adminDb.admin_users.findMany({
    orderBy: { created_at: "desc" },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Admin Users</h1>
        <CreateAdminDialog />
      </div>

      <div className="rounded-md border">
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
              <tr key={user.id} className="border-b">
                <td className="px-4 py-3 text-sm font-medium">
                  <Link href={`/admin-users/${user.id}`} className="text-blue-400 hover:underline">
                    {user.username}
                  </Link>
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{user.email}</td>
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
      </div>
    </div>
  );
}
