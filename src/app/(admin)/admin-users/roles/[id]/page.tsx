import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, KeyRound, FileText, ShieldCheck, Users } from "lucide-react";
import { requireAdmin } from "@/lib/dal";
import { PageHero, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { getRole } from "../actions";
import { RoleEditor } from "../role-editor";

export const metadata = { title: "Role" };

export default async function RoleDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdmin();
  const { id } = await params;
  const role = await getRole(id);
  if (!role) notFound();

  // capabilities holds both page routes and `__can_*` action flags.
  const pageCount = role.capabilities.filter((k) => !k.startsWith("__")).length;
  const actionCount = role.capabilities.length - pageCount;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <Link
            href="/admin-users/roles"
            className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
          >
            <ArrowLeft className="size-4" />
          </Link>
          <div className="flex size-10 items-center justify-center rounded-xl bg-amber-500/10">
            <KeyRound className="size-5 text-amber-500" />
          </div>
          <div className="flex-1">
            <h1 className="text-2xl font-bold leading-tight">{role.name}</h1>
            {role.description && (
              <p className="text-sm text-muted-foreground">{role.description}</p>
            )}
          </div>
        </div>
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
