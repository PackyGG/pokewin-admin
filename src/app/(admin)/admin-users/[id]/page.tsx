import { notFound } from "next/navigation";
import {
  UserCog,
  Activity,
  Clock,
  ShieldCheck,
  CheckCircle2,
  XCircle,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { isMainOwner } from "@/lib/owners";
import {
  getAdminUserDetail,
  getAdminUserAuditStats,
  getAdminUserAuditEvents,
  type AdminAuditEventItem,
  type AdminAuditStats,
} from "@/lib/queries/admin-users";
import type { PaginatedResult } from "@/lib/types";
import {
  safeQuery,
  safeQueryOrNull,
  REWARD_QUERY_TIMEOUT_MS,
  type SafeQueryResult,
} from "@/lib/errors/safe-query";
import { getLimitsForAdmin } from "@/lib/balance-limits";
import { adminRolesColumnExists } from "@/lib/admin-user-roles";
import { listAssignablePresets } from "../_roles/custom-roles-actions";
import { Badge } from "@/components/ui/badge";
import { formatRelative } from "@/lib/utils/format";
import { PageHero, PageHeroIdentity, KpiTile } from "@/components/modern-panels";
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

  // Balance limits + admin audit events are admin-only — only fetch (and
  // only ship to the client) if the current viewer is a real admin.
  // Non-admins with /admin-users access (e.g. via custom role) never see
  // the data on the wire, so it can't leak through React DevTools or DOM
  // inspection. The admin-audit feed is especially sensitive: it surfaces
  // every action this admin took (balance adjustments, withdrawals,
  // permissions changes, etc.) — non-admin viewers must not be able to
  // browse it.
  const isCurrentUserAdmin = session.role === "admin";

  // The owner-management card is visible ONLY to the main owner (motha). Other
  // owners get full access but cannot grow/shrink the owner set — this matches
  // the `requireMainOwner` gate on the `setAdminOwner` action.
  const viewerIsMainOwner = isMainOwner(session);

  const emptyAuditEvents: PaginatedResult<AdminAuditEventItem> = {
    data: [],
    total: 0,
    page: auditPage,
    perPage: auditPerPage,
    totalPages: 0,
  };

  // Degraded fallbacks so a single read failing/timing out can't white-screen
  // the whole detail page — each read is wrapped in safeQuery/safeQueryOrNull
  // (mirrors /audit). The render keeps working on empty states; only `detail`
  // failing falls through to notFound() (there is no hero/identity to paint
  // without it), which is still a graceful degrade vs an unhandled crash.
  const emptyAuditStats: AdminAuditStats = {
    totalActions: 0,
    lastActive: null,
    eventsByType: [],
    dailyActivity: [],
  };
  type BalanceLimitsResult = Awaited<ReturnType<typeof getLimitsForAdmin>>;
  const emptyBalanceLimits: BalanceLimitsResult = [];
  const emptyPresets: { id: string; name: string }[] = [];

  const [
    detailResult,
    auditStatsResult,
    auditEventsResult,
    balanceLimitsResult,
    rolesColumnExistsResult,
    assignablePresetsResult,
  ] = await Promise.all([
    safeQueryOrNull(
      () => getAdminUserDetail(id),
      "adminUsers.detail",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    safeQuery(
      () => getAdminUserAuditStats(id),
      emptyAuditStats,
      "adminUsers.auditStats",
      REWARD_QUERY_TIMEOUT_MS,
    ),
    isCurrentUserAdmin
      ? safeQuery(
          () =>
            getAdminUserAuditEvents(id, auditPage, auditPerPage, {
              eventType: typeof sp.auditEventType === "string" ? sp.auditEventType : undefined,
              search: typeof sp.auditSearch === "string" ? sp.auditSearch : undefined,
            }),
          emptyAuditEvents,
          "adminUsers.auditEvents",
          REWARD_QUERY_TIMEOUT_MS,
        )
      : Promise.resolve<SafeQueryResult<PaginatedResult<AdminAuditEventItem>>>({
          data: emptyAuditEvents,
          error: null,
          kind: null,
        }),
    // Whether the additive `roles` column is migrated — drives the honest
    // "multi-role needs a migration" notice in the Roles card. Only needed
    // by an admin viewer (the card is hidden otherwise); skip the probe
    // for non-admin viewers, mirroring the balance-limits gate above.
    isCurrentUserAdmin
      ? safeQuery(
          () => getLimitsForAdmin(id),
          emptyBalanceLimits,
          "adminUsers.balanceLimits",
          REWARD_QUERY_TIMEOUT_MS,
        )
      : Promise.resolve<SafeQueryResult<BalanceLimitsResult>>({
          data: emptyBalanceLimits,
          error: null,
          kind: null,
        }),
    isCurrentUserAdmin
      ? safeQuery(
          () => adminRolesColumnExists(),
          false,
          "adminUsers.rolesColumn",
          REWARD_QUERY_TIMEOUT_MS,
        )
      : Promise.resolve<SafeQueryResult<boolean>>({
          data: false,
          error: null,
          kind: null,
        }),
    // Assignable role presets (custom roles) for the "Role preset" select in
    // the Roles card. Admin-only surface; skip the read for non-admin viewers.
    isCurrentUserAdmin
      ? safeQuery(
          () => listAssignablePresets(),
          emptyPresets,
          "adminUsers.presets",
          REWARD_QUERY_TIMEOUT_MS,
        )
      : Promise.resolve<SafeQueryResult<{ id: string; name: string }[]>>({
          data: emptyPresets,
          error: null,
          kind: null,
        }),
  ]);

  const detail = detailResult.data;
  const auditStats = auditStatsResult.data;
  const auditEvents = auditEventsResult.data;
  const balanceLimits = balanceLimitsResult.data;
  const rolesColumnExists = rolesColumnExistsResult.data;
  const assignablePresets = assignablePresetsResult.data;

  if (!detail) notFound();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={UserCog}
          accent="purple"
          backHref="/admin-users"
          title={detail.username}
          titleClassName="truncate"
          badges={
            <div className="flex flex-wrap gap-1">
              {detail.roles.map((r) => (
                <Badge key={r} variant="outline" className="text-xs uppercase">
                  {r}
                </Badge>
              ))}
            </div>
          }
          subtitle={detail.email}
          subtitleClassName="truncate"
        />
      </PageHero>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 sm:gap-3 md:grid-cols-4">
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
          rolesColumnExists={rolesColumnExists}
          viewerIsMainOwner={viewerIsMainOwner}
          assignablePresets={assignablePresets}
        />
      </FadeIn>
    </div>
  );
}
