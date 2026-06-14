import { notFound } from "next/navigation";
import {
  KeyRound,
  Lock,
  FileText,
  ShieldCheck,
  Users,
  SlidersHorizontal,
} from "lucide-react";
import { requireAdmin } from "@/lib/dal";
import { isUuid } from "@/lib/utils/ids";
import { PageHero, PageHeroIdentity, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { getRoleEditorData } from "../../_roles/role-editor-data";
import { RoleEditor } from "../../_roles/role-editor";

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
  const data = await getRoleEditorData(id);
  if (!data) notFound();

  // capabilities holds both page routes and `__can_*` action flags.
  const pageCount = data.capabilities.filter((k) => !k.startsWith("__")).length;
  const actionCount = data.capabilities.length - pageCount;

  // A non-null per-role limit on any period → surface it as a KPI.
  const ba = data.limits.balanceAdjustment;
  const hasBalanceCap =
    ba.daily !== null || ba.weekly !== null || ba.monthly !== null;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={data.isSystem ? Lock : KeyRound}
          accent={data.isSystem ? "amber" : "emerald"}
          backHref="/admin-users?tab=roles"
          title={data.name}
          subtitle={
            data.description ||
            (data.isSystem ? "Built-in role" : "Custom role")
          }
        />
      </PageHero>

      {data.bypass ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <KpiTile
            label="Access"
            value="Full bypass"
            sub="Gate ignores all checks"
            icon={ShieldCheck}
            accent="emerald"
          />
          <KpiTile
            label="Holders"
            value={String(data.holderCount)}
            icon={Users}
            accent="blue"
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-4">
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
            label={data.isSystem ? "Holders" : "Assigned Admins"}
            value={String(data.holderCount)}
            icon={Users}
            accent="cyan"
          />
          <KpiTile
            label="Balance Cap"
            value={hasBalanceCap ? "Set" : "None"}
            sub={hasBalanceCap ? "Role default" : "Unlimited"}
            icon={SlidersHorizontal}
            accent={hasBalanceCap ? "rose" : "emerald"}
          />
        </div>
      )}

      <FadeIn>
        <RoleEditor data={data} />
      </FadeIn>
    </div>
  );
}
