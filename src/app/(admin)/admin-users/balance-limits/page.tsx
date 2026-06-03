import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { ArrowLeft, Wallet } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";
import { PageHero, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { TableSkeleton } from "@/components/loading-skeletons";
import { Button } from "@/components/ui/button";
import { BalanceLimitsOverview } from "./balance-limits-overview";
import type { limit_period_type } from "@/generated/admin-prisma/client";

export const metadata = { title: "Balance Limits" };

type LimitRow = {
  id: string;
  adminUserId: string;
  adminUsername: string;
  adminEmail: string;
  adminRole: string;
  periodType: limit_period_type;
  maxAmount: number;
  setByUsername: string | null;
  updatedAt: string;
};

/**
 * Deferred table section. The cap `rows` are already shaped on the server
 * (cheap — derived from the limits fetch the page already ran), but the
 * "Add limit" dialog needs the full active-admin roster, which is the one
 * extra query worth not blocking the hero/KPIs on. Streamed under its own
 * Suspense so the hero + KPI strip paint immediately while this resolves.
 */
async function BalanceLimitsTableSection({ rows }: { rows: LimitRow[] }) {
  // Every active admin — used by the "Add limit" dialog so a cap can be
  // placed on any target, not only ones that already have one.
  const allAdmins = await adminDb.admin_users.findMany({
    where: { is_active: true },
    select: { id: true, username: true, email: true, role: true },
    orderBy: { username: "asc" },
  });

  return (
    <BalanceLimitsOverview
      rows={rows}
      allAdmins={allAdmins.map((a) => ({
        id: a.id,
        username: a.username,
        email: a.email,
        role: a.role,
      }))}
    />
  );
}

/**
 * Single-page audit + edit surface for every admin_balance_limits row
 * across the panel. Lets a real admin spot caps that shouldn't exist
 * (e.g. orphans from the old role-cascade) and edit/delete them
 * inline without drilling into each profile.
 *
 * Admin-only — non-admins with `/admin-users` access never see this
 * route. The redirect (rather than a hidden link) is defence-in-depth:
 * even if someone hand-crafts the URL, they get bounced.
 */
export default async function BalanceLimitsOverviewPage() {
  const session = await requirePageAccess("/admin-users");
  if (session.role !== "admin") {
    redirect("/admin-users");
  }

  // Pull every cap row, then enrich with the admin user it belongs to.
  // Two separate queries because admin_balance_limits has no FK back
  // to admin_users — joining client-side keeps the schema simple and
  // the data volumes here are tiny (one row per period per admin).
  const limits = await adminDb.admin_balance_limits.findMany({
    orderBy: [{ admin_user_id: "asc" }, { period_type: "asc" }],
  });

  const adminIds = [
    ...new Set(
      limits
        .flatMap((l) => [l.admin_user_id, l.created_by, l.updated_by])
        .filter((id): id is string => !!id),
    ),
  ];

  const admins =
    adminIds.length > 0
      ? await adminDb.admin_users.findMany({
          where: { id: { in: adminIds } },
          select: { id: true, username: true, email: true, role: true },
        })
      : [];

  const adminMap = new Map(admins.map((a) => [a.id, a]));

  const rows = limits.map((l) => {
    const target = adminMap.get(l.admin_user_id);
    const setBy = l.updated_by ? adminMap.get(l.updated_by) : null;
    return {
      id: l.id,
      adminUserId: l.admin_user_id,
      adminUsername: target?.username ?? "Unknown",
      adminEmail: target?.email ?? "",
      adminRole: target?.role ?? "unknown",
      periodType: l.period_type,
      maxAmount: Number(l.max_amount),
      setByUsername: setBy?.username ?? null,
      updatedAt: l.updated_at.toISOString(),
    };
  });

  // KPI summary — useful at a glance for spotting whether caps look
  // proportionate to the team size.
  const distinctAdminsWithCaps = new Set(rows.map((r) => r.adminUserId)).size;
  const totalDailyCap = rows
    .filter((r) => r.periodType === "daily")
    .reduce((sum, r) => sum + r.maxAmount, 0);
  const totalWeeklyCap = rows
    .filter((r) => r.periodType === "weekly")
    .reduce((sum, r) => sum + r.maxAmount, 0);
  const totalMonthlyCap = rows
    .filter((r) => r.periodType === "monthly")
    .reduce((sum, r) => sum + r.maxAmount, 0);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="size-9"
              render={
                <Link href="/admin-users" aria-label="Back to admin users">
                  <ArrowLeft className="size-4" />
                </Link>
              }
            />
            <div className="flex size-10 items-center justify-center rounded-xl bg-amber-500/10">
              <Wallet className="size-5 text-amber-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">
                Balance Limits
              </h1>
              <p className="text-sm text-muted-foreground">
                Per-admin caps on how much they can adjust user balances
                within a period. Add, edit, or remove any cap here.
              </p>
            </div>
          </div>
        </div>
      </PageHero>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile
          label="Admins With Caps"
          value={String(distinctAdminsWithCaps)}
          icon={Wallet}
          accent="amber"
        />
        <KpiTile
          label="Total Daily Cap"
          value={`$${totalDailyCap.toLocaleString()}`}
          icon={Wallet}
          accent="blue"
        />
        <KpiTile
          label="Total Weekly Cap"
          value={`$${totalWeeklyCap.toLocaleString()}`}
          icon={Wallet}
          accent="purple"
        />
        <KpiTile
          label="Total Monthly Cap"
          value={`$${totalMonthlyCap.toLocaleString()}`}
          icon={Wallet}
          accent="cyan"
        />
      </div>

      <FadeIn>
        <Suspense
          key="balance-limits-table"
          fallback={<TableSkeleton rows={6} columns={7} />}
        >
          <BalanceLimitsTableSection rows={rows} />
        </Suspense>
      </FadeIn>
    </div>
  );
}
