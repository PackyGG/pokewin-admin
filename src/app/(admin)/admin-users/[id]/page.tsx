import { notFound } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  UserCog,
  Activity,
  Clock,
  ShieldCheck,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  getAdminUserDetail,
  getAdminUserAuditStats,
  getAdminUserAuditEvents,
} from "@/lib/queries/admin-users";
import { getLimitsForAdmin } from "@/lib/balance-limits";
import { Badge } from "@/components/ui/badge";
import { formatRelative } from "@/lib/utils/format";
import { PageHero, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { AdminUserTabs } from "./admin-user-tabs";

export const metadata = { title: "Admin User Detail" };

const AUDIT_PER_PAGE_OPTIONS = [10, 20, 50, 100] as const;

export default async function AdminUserDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePageAccess("/admin-users");
  const { id } = await params;
  const sp = await searchParams;

  const auditPage = Math.max(1, Number(sp.auditPage) || 1);
  const auditPerPage = AUDIT_PER_PAGE_OPTIONS.includes(Number(sp.auditPerPage) as 10 | 20 | 50 | 100)
    ? Number(sp.auditPerPage)
    : 20;

  // Balance limits are admin-only — only fetch (and only ship to the
  // client) if the current viewer is a real admin. Non-admins with
  // /admin-users access (e.g. via custom role) never see the data on
  // the wire, so it can't leak through React DevTools or DOM inspection.
  const isCurrentUserAdmin = session.role === "admin";

  const [detail, auditStats, auditEvents, balanceLimits] = await Promise.all([
    getAdminUserDetail(id),
    getAdminUserAuditStats(id),
    getAdminUserAuditEvents(id, auditPage, auditPerPage, {
      eventType: typeof sp.auditEventType === "string" ? sp.auditEventType : undefined,
      search: typeof sp.auditSearch === "string" ? sp.auditSearch : undefined,
    }),
    isCurrentUserAdmin ? getLimitsForAdmin(id) : Promise.resolve([]),
  ]);

  if (!detail) notFound();

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <Link
              href="/admin-users"
              className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground shrink-0"
            >
              <ArrowLeft className="size-4" />
            </Link>
            <div className="flex size-10 items-center justify-center rounded-xl bg-purple-500/10 shrink-0">
              <UserCog className="size-5 text-purple-500" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-xl sm:text-2xl font-bold leading-tight truncate">
                  {detail.username}
                </h1>
                <Badge variant="outline" className="text-xs uppercase">
                  {detail.role}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground truncate">{detail.email}</p>
            </div>
          </div>
        </div>
      </PageHero>

      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4">
        <KpiTile
          label="Status"
          value={detail.isActive ? "Active" : "Inactive"}
          icon={detail.isActive ? CheckCircle2 : XCircle}
          accent={detail.isActive ? "emerald" : "rose"}
        />
        <KpiTile
          label="2FA"
          value={detail.totpEnabled ? "Enabled" : "Not set"}
          icon={ShieldCheck}
          accent={detail.totpEnabled ? "emerald" : "amber"}
        />
        <KpiTile
          label="Total Actions"
          value={String(auditStats.totalActions)}
          icon={Activity}
          accent="blue"
        />
        <KpiTile
          label="Last Active"
          value={
            auditStats.lastActive ? formatRelative(auditStats.lastActive) : "Never"
          }
          icon={Clock}
          accent="cyan"
        />
      </div>

      <FadeIn>
        <AdminUserTabs
          detail={detail}
          auditStats={auditStats}
          auditEvents={auditEvents}
          balanceLimits={balanceLimits.map((l) => ({
            ...l,
            max_amount: Number(l.max_amount),
            created_at: l.created_at.toISOString(),
            updated_at: l.updated_at.toISOString(),
          }))}
          isCurrentUserAdmin={isCurrentUserAdmin}
        />
      </FadeIn>
    </div>
  );
}
