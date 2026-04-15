import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  getAdminUserDetail,
  getAdminUserAuditStats,
  getAdminUserAuditEvents,
} from "@/lib/queries/admin-users";
import { getLimitsForAdmin } from "@/lib/balance-limits";
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

  const [detail, auditStats, auditEvents, balanceLimits] = await Promise.all([
    getAdminUserDetail(id),
    getAdminUserAuditStats(id),
    getAdminUserAuditEvents(id, auditPage, auditPerPage, {
      eventType: typeof sp.auditEventType === "string" ? sp.auditEventType : undefined,
      search: typeof sp.auditSearch === "string" ? sp.auditSearch : undefined,
    }),
    getLimitsForAdmin(id),
  ]);

  if (!detail) notFound();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link
          href="/admin-users"
          className="inline-flex size-9 items-center justify-center rounded-md hover:bg-accent hover:text-accent-foreground"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-bold">{detail.username}</h1>
          <p className="text-sm text-muted-foreground">{detail.email}</p>
        </div>
      </div>
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
        isCurrentUserAdmin={session.role === "admin"}
      />
    </div>
  );
}
