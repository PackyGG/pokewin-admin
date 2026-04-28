import Link from "next/link";
import { KeyRound, Lock, Settings, Users } from "lucide-react";
import { requireAdmin } from "@/lib/dal";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/utils/format";
import { PageHero, SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { listRoles } from "./actions";
import { CreateRoleButton } from "./create-role-button";

export const metadata = { title: "Admin Roles" };

export default async function AdminRolesPage() {
  await requireAdmin();
  const roles = await listRoles();

  const systemCount = roles.filter((r) => r.is_system).length;
  const customCount = roles.length - systemCount;
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
                System roles are read-only. Custom roles can be edited and
                deleted freely.
              </p>
            </div>
          </div>
          <CreateRoleButton />
        </div>
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile
          label="Total Roles"
          value={String(roles.length)}
          icon={KeyRound}
          accent="amber"
        />
        <KpiTile
          label="System"
          value={String(systemCount)}
          icon={Lock}
          accent="blue"
        />
        <KpiTile
          label="Custom"
          value={String(customCount)}
          icon={Settings}
          accent="purple"
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
        <FadeIn className="rounded-md border overflow-hidden">
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
                <tr key={role.id} className="border-b last:border-b-0">
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
        </FadeIn>
      </div>
    </div>
  );
}
