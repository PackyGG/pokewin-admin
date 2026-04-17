import { ShieldCheck } from "lucide-react";
import { requireAdmin } from "@/lib/dal";
import { ADMIN_PAGES } from "@/lib/admin-pages";
import { getRolePermissions } from "./actions";
import { RolePermissionsEditor } from "./role-permissions-editor";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Role Permissions" };

export default async function RolePermissionsPage() {
  await requireAdmin();
  const permissions = await getRolePermissions();

  // Group pages by their group label for the UI
  const groupedPages: { group: string; pages: { key: string; label: string }[] }[] = [];
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
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <ShieldCheck className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Role Permissions</h1>
            <p className="text-sm text-muted-foreground">
              Configure page access and capabilities for each role. Changes
              apply to all existing and new users of that role.
            </p>
          </div>
        </div>
      </PageHero>

      <FadeIn>
        <RolePermissionsEditor
          groupedPages={groupedPages}
          initialPermissions={permissions}
        />
      </FadeIn>
    </div>
  );
}
