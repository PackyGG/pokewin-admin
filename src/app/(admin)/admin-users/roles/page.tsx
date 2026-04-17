import Link from "next/link";
import { requireAdmin } from "@/lib/dal";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils/format";
import { listRoles } from "./actions";
import { CreateRoleButton } from "./create-role-button";

export const metadata = { title: "Admin Roles" };

export default async function AdminRolesPage() {
  await requireAdmin();
  const roles = await listRoles();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Admin Roles</h1>
          <p className="text-sm text-muted-foreground mt-1">
            System roles are built in and read-only. Custom roles can be edited
            and deleted freely.
          </p>
        </div>
        <CreateRoleButton />
      </div>

      <div className="rounded-md border">
        <table className="w-full">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-4 py-3 text-left text-sm font-medium">Name</th>
              <th className="px-4 py-3 text-left text-sm font-medium">Type</th>
              <th className="px-4 py-3 text-left text-sm font-medium">Capabilities</th>
              <th className="px-4 py-3 text-left text-sm font-medium">Users</th>
              <th className="px-4 py-3 text-left text-sm font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {roles.length === 0 && (
              <tr>
                <td
                  colSpan={5}
                  className="px-4 py-8 text-center text-sm text-muted-foreground"
                >
                  No roles yet. Run <code>npm run admin:migrate</code> and{" "}
                  <code>npm run admin:seed</code> to create the built-in roles.
                </td>
              </tr>
            )}
            {roles.map((role) => (
              <tr key={role.id} className="border-b">
                <td className="px-4 py-3 text-sm font-medium">
                  <Link
                    href={`/admin-users/roles/${role.id}`}
                    className="text-blue-400 hover:underline"
                  >
                    {role.name}
                  </Link>
                  {role.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {role.description}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3">
                  {role.is_system ? (
                    <Badge
                      variant="outline"
                      className="bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30"
                    >
                      System
                    </Badge>
                  ) : (
                    <Badge variant="outline">Custom</Badge>
                  )}
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground">
                  {role.capabilities.length}
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground">
                  {role.user_count}
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground">
                  {formatDateTime(role.updated_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
