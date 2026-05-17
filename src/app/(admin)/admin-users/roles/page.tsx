import Link from "next/link";
import { KeyRound, Users } from "lucide-react";
import { requireAdmin } from "@/lib/dal";
import { formatDateTime } from "@/lib/utils/format";
import { PageHero, SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { listRoles } from "./actions";
import { CreateRoleButton } from "./create-role-button";

export const metadata = { title: "Admin Roles" };

export default async function AdminRolesPage() {
  await requireAdmin();
  const roles = await listRoles();

  const totalUsers = roles.reduce((acc, r) => acc + r.user_count, 0);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-amber-500/10">
              <KeyRound className="size-5 text-amber-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">Admin Roles</h1>
              <p className="text-sm text-muted-foreground">
                Reusable permission presets. Assign a role to an admin on
                their profile, then fine-tune per user from there.
              </p>
            </div>
          </div>
          <CreateRoleButton />
        </div>
      </PageHero>

      <div className="grid grid-cols-2 gap-3">
        <KpiTile
          label="Total Roles"
          value={String(roles.length)}
          icon={KeyRound}
          accent="amber"
        />
        <KpiTile
          label="Assigned Admins"
          value={String(totalUsers)}
          icon={Users}
          accent="cyan"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading icon={KeyRound} title="All Roles" />
        <FadeIn className="overflow-hidden rounded-md border">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left text-sm font-medium">Name</th>
                <th className="px-4 py-3 text-left text-sm font-medium">
                  Permissions
                </th>
                <th className="px-4 py-3 text-left text-sm font-medium">Users</th>
                <th className="px-4 py-3 text-left text-sm font-medium">
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {roles.length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-8 text-center text-sm text-muted-foreground"
                  >
                    No roles yet. Create your first role to get started.
                  </td>
                </tr>
              )}
              {roles.map((role) => (
                <tr key={role.id} className="border-b last:border-b-0">
                  <td className="px-4 py-3 text-sm font-medium">
                    <Link
                      href={`/admin-users/roles/${role.id}`}
                      className="text-blue-400 hover:underline"
                    >
                      {role.name}
                    </Link>
                    {role.description && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {role.description}
                      </p>
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
        </FadeIn>
      </div>
    </div>
  );
}
