import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  FileText,
  ShieldCheck,
  Users,
  SlidersHorizontal,
} from "lucide-react";
import { requireAdmin } from "@/lib/dal";
import { isUuid } from "@/lib/utils/ids";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHero,
  PageHeroIdentity,
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import {
  getRoleEditorData,
  getRoleHolders,
} from "../../_roles/role-editor-data";
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
  // Only the editor payload is awaited — it drives the notFound() guard and
  // every KPI. The holder list feeds one section at the bottom of the page, so
  // it streams behind its own <Suspense> instead of holding up the hero.
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
        <PageHeroIdentity backHref="/admin-users?tab=roles" />
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

      {/* ── Assigned admins (RoleV2 P1) ── who currently holds this role.
          Built-in: effective-role holders; custom: role_id links. Each links to
          the admin's profile, where the "Role preset" select assigns/unassigns
          a custom role. Streamed: nothing above it depends on the holder list
          (the "Holders" KPI reads `data.holderCount`), so it must not sit in
          the page-body await. */}
      <div className="space-y-3">
        <SectionHeading
          icon={Users}
          title="Assigned admins"
          action={
            <Badge variant="outline" className="text-xs">
              {data.holderCount} total
            </Badge>
          }
        />
        <Suspense
          fallback={
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-9 w-28 rounded-md" />
              ))}
            </div>
          }
        >
          <RoleHoldersList roleId={id} isSystem={data.isSystem} />
        </Suspense>
      </div>
    </div>
  );
}

async function RoleHoldersList({
  roleId,
  isSystem,
}: {
  roleId: string;
  isSystem: boolean;
}) {
  const holders = await getRoleHolders(roleId);

  if (holders.length === 0) {
    return (
      <p className="rounded-md border border-dashed bg-muted/20 p-4 text-sm text-muted-foreground">
        {isSystem
          ? "No admin currently holds this role."
          : "No admin is assigned this role yet. Assign it from an admin’s profile (the “Role preset” select)."}
      </p>
    );
  }

  return (
    <FadeIn>
      <div className="flex flex-wrap gap-2">
        {holders.map((h) => (
          <Link
            key={h.id}
            href={`/admin-users/${h.id}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <span
              className={
                h.isActive
                  ? "size-1.5 rounded-full bg-emerald-500"
                  : "size-1.5 rounded-full bg-muted-foreground/40"
              }
              aria-hidden
            />
            {h.username}
          </Link>
        ))}
      </div>
    </FadeIn>
  );
}
