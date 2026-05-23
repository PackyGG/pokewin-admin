import Link from "next/link";
import { KeyRound, ShieldCheck } from "lucide-react";
import { requireAdmin } from "@/lib/dal";
import { ADMIN_PAGES } from "@/lib/admin-pages";
import { formatDateTime } from "@/lib/utils/format";
import { getRolePermissions } from "./actions";
import { listRoles } from "./custom-roles-actions";
import { RolePermissionsEditor } from "./role-permissions-editor";
import { CreateRoleButton } from "./create-role-button";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";

export const metadata = { title: "Roles" };

/**
 * Unified roles hub. One page for both kinds of role:
 *   • Custom roles   — reusable presets in admin_roles. Create here,
 *     assign on an admin's profile, edit at /settings/roles/[id].
 *   • Built-in roles — the fixed support / marketing / creator /
 *     pack_creator roles; editing one re-applies to all its users.
 * Previously these lived on two separate pages (/admin-users/roles +
 * /settings/roles) which made the New Role button hard to find.
 */
export default async function RolesPage() {
  await requireAdmin();
  const [permissions, customRoles] = await Promise.all([
    getRolePermissions(),
    listRoles(),
  ]);

  // Group pages by their group label for the built-in role editor.
  const groupedPages: {
    group: string;
    pages: { key: string; label: string }[];
  }[] = [];
  const seen = new Set<string>();
  for (const page of ADMIN_PAGES) {
    if (!seen.has(page.group)) {
      seen.add(page.group);
      groupedPages.push({
        group: page.group,
        pages: ADMIN_PAGES.filter((p) => p.group === page.group).map((p) => ({
          key: p.key,
          label: p.label,
        })),
      });
    }
  }

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ShieldCheck}
          title="Roles"
          subtitle="Custom roles and built-in roles in one place. Create a custom role as a reusable preset, or edit a built-in role to change access for everyone who has it."
        />
      </PageHero>

      {/* Custom roles — reusable presets stored in admin_roles. Create
          here, then assign on an admin user's profile. */}
      <div className="space-y-3">
        <SectionHeading
          icon={KeyRound}
          title="Custom Roles"
          action={<CreateRoleButton />}
        />
        {customRoles.length === 0 ? (
          <FadeIn className="rounded-md border">
            <EmptyState
              icon={KeyRound}
              title="No custom roles yet"
              description="Use the New Role button above to create your first reusable preset."
              compact
            />
          </FadeIn>
        ) : (
          <FadeIn className="space-y-2">
            {/* Desktop table (>=md). */}
            <div className="hidden overflow-x-auto rounded-md border md:block">
              <table className="w-full">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Name
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Permissions
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Users
                    </th>
                    <th className="px-4 py-3 text-left text-sm font-medium">
                      Updated
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {customRoles.map((role) => (
                    <tr key={role.id} className="border-b last:border-b-0">
                      <td className="px-4 py-3 text-sm font-medium">
                        <Link
                          href={`/settings/roles/${role.id}`}
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
            </div>

            {/* Mobile card list (<md). */}
            <div className="space-y-2 md:hidden">
              {customRoles.map((role) => (
                <Link
                  key={role.id}
                  href={`/settings/roles/${role.id}`}
                  className="block rounded-lg border bg-card p-3 transition-colors hover:border-border/80"
                >
                  <div className="font-medium text-blue-400">{role.name}</div>
                  {role.description && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {role.description}
                    </p>
                  )}
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>{role.capabilities.length} permissions</span>
                    <span>{role.user_count} users</span>
                    <span>Updated {formatDateTime(role.updated_at)}</span>
                  </div>
                </Link>
              ))}
            </div>
          </FadeIn>
        )}
      </div>

      {/* Built-in roles — fixed enum roles. Editing one re-applies to
          every user currently on that role. */}
      <div className="space-y-3">
        <SectionHeading icon={ShieldCheck} title="Built-in Roles" />
        <FadeIn>
          <RolePermissionsEditor
            groupedPages={groupedPages}
            initialPermissions={permissions}
          />
        </FadeIn>
      </div>
    </div>
  );
}
