import { notFound } from "next/navigation";
import { KeyRound, FileText, ShieldCheck, Users } from "lucide-react";
import { requireAdmin } from "@/lib/dal";
import { isUuid } from "@/lib/utils/ids";
import { PageHero, PageHeroIdentity, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { getRole } from "../custom-roles-actions";
import { RoleEditor } from "../role-editor";

export const metadata = { title: "Role" };

export default async function RoleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  // Shape-check UUID before any DB call — see src/lib/utils/ids.ts.
  if (!isUuid(id)) notFound();
  const role = await getRole(id);
  if (!role) notFound();

  // capabilities holds both page routes and `__can_*` action flags.
  const pageCount = role.capabilities.filter((k) => !k.startsWith("__")).length;
  const actionCount = role.capabilities.length - pageCount;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={KeyRound}
          accent="amber"
          backHref="/settings/roles"
          title={role.name}
          subtitle={role.description || undefined}
        />
      </PageHero>

      <div className="grid grid-cols-3 gap-3">
        <KpiTile
          label="Page Access"
          value={String(pageCount)}
          icon={FileText}
          accent="blue"
        />
        <KpiTile
          label="Capabilities"
          value={String(actionCount)}
          icon={ShieldCheck}
          accent="amber"
        />
        <KpiTile
          label="Assigned Admins"
          value={String(role.user_count)}
          icon={Users}
          accent="cyan"
        />
      </div>

      <FadeIn>
        <RoleEditor role={role} />
      </FadeIn>
    </div>
  );
}
