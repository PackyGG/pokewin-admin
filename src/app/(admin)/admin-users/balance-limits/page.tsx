import { Suspense } from "react";
import { redirect } from "next/navigation";
import { sql } from "drizzle-orm";
import { Wallet } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { adminDrizzle } from "@/lib/admin-db";
import { PageHero, PageHeroIdentity, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { TableSkeleton } from "@/components/loading-skeletons";
import { BalanceLimitsOverview } from "./balance-limits-overview";
import type { limit_period_type } from "@/lib/balance-limits";

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
  const allAdmins = (await adminDrizzle.execute<{
    id: string;
    username: string;
    email: string;
    role: string;
  }>(sql`
    SELECT id::text, username, email, role::text AS role
    FROM admin_users
    WHERE is_active
    ORDER BY username ASC
  `)).rows;

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
  const limits = (await adminDrizzle.execute<{
    id: string;
    admin_user_id: string;
    admin_username: string;
    admin_email: string;
    admin_role: string;
    period_type: limit_period_type;
    max_amount: string;
    set_by_username: string | null;
    updated_at: Date | string;
  }>(sql`
    SELECT l.id::text, l.admin_user_id,
           COALESCE(target.username, 'Unknown') AS admin_username,
           COALESCE(target.email, '') AS admin_email,
           COALESCE(target.role::text, 'unknown') AS admin_role,
           l.period_type::text AS period_type, l.max_amount::text AS max_amount,
           setter.username AS set_by_username, l.updated_at
    FROM admin_balance_limits l
    LEFT JOIN admin_users target ON target.id::text = l.admin_user_id
    LEFT JOIN admin_users setter ON setter.id::text = l.updated_by
    ORDER BY l.admin_user_id ASC, l.period_type ASC
  `)).rows;

  const rows = limits.map((l) => ({
    id: l.id,
    adminUserId: l.admin_user_id,
    adminUsername: l.admin_username,
    adminEmail: l.admin_email,
    adminRole: l.admin_role,
    periodType: l.period_type,
    maxAmount: Number(l.max_amount),
    setByUsername: l.set_by_username,
    updatedAt: new Date(l.updated_at).toISOString(),
  }));

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
        <PageHeroIdentity backHref="/admin-users" />
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
