import { Shield, CheckCircle2, XCircle, ShieldCheck, Wallet, UserCog } from "lucide-react";
import Link from "next/link";
import { requirePageAccess } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";
import { getEffectiveRoles, ALL_ADMIN_ROLES } from "@/lib/admin-roles";
import {
  readAdminUsersWithRoles,
  adminRolesColumnExists,
} from "@/lib/admin-user-roles";
import { Button } from "@/components/ui/button";
import { AdminUsersTable, type AdminUserRow } from "./admin-users-table";
import { CreateAdminDialog } from "./create-dialog";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Users" };

export default async function AdminUsersPage() {
  const session = await requirePageAccess("/admin-users");
  // Surface balance-limit info only to real admins. Non-admins with
  // /admin-users access (custom role) should not see who is or isn't
  // limited — that's privileged information about other admins.
  const isCurrentUserAdmin = session.role === "admin";

  // Explicit select — same defensive rationale as login/actions.ts. A
  // missing column from an unrun migration would otherwise crash this page
  // with P2022 before anything renders. `readAdminUsersWithRoles` degrades
  // each row to `roles: []` (→ effective `[role]`) when the additive
  // `roles` column hasn't been migrated yet.
  //
  // SECURITY: only safe, non-secret columns are selected. Never
  // password_hash, totp_secret, or recovery_codes — those stay server-side.
  const [users, balanceLimits, rolesColumnExists] = await Promise.all([
    readAdminUsersWithRoles(
      () =>
        adminDb.admin_users.findMany({
          orderBy: { created_at: "desc" },
          select: {
            id: true,
            email: true,
            username: true,
            display_username: true,
            role: true,
            roles: true,
            totp_enabled: true,
            is_active: true,
            allowed_pages: true,
            created_at: true,
          },
        }),
      () =>
        adminDb.admin_users.findMany({
          orderBy: { created_at: "desc" },
          select: {
            id: true,
            email: true,
            username: true,
            display_username: true,
            role: true,
            totp_enabled: true,
            is_active: true,
            allowed_pages: true,
            created_at: true,
          },
        }),
    ),
    isCurrentUserAdmin
      ? adminDb.admin_balance_limits.findMany({
          select: { admin_user_id: true, period_type: true },
        })
      : Promise.resolve([]),
    // Whether the additive `roles` column is migrated. Drives the honest
    // "multi-role needs a migration" notice in the per-row role editor.
    adminRolesColumnExists(),
  ]);

  // Session-derived activity per admin. One groupBy each (not N queries):
  //   • lastLogin  — max(logged_in_at) per user → "Last login" column.
  //   • activeNow  — count of sessions that are NOT logged out and not
  //                  expired → "active sessions" indicator. Mirrors the
  //                  isActive derivation in getAdminUserSessions.
  const now = new Date();
  const [lastLoginRows, activeSessionRows] = await Promise.all([
    adminDb.admin_sessions.groupBy({
      by: ["admin_user_id"],
      _max: { logged_in_at: true },
    }),
    adminDb.admin_sessions.groupBy({
      by: ["admin_user_id"],
      where: { logged_out_at: null, expires_at: { gt: now } },
      _count: { _all: true },
    }),
  ]);

  const lastLoginByAdmin = new Map<string, string>();
  for (const r of lastLoginRows) {
    if (r._max.logged_in_at) {
      lastLoginByAdmin.set(r.admin_user_id, r._max.logged_in_at.toISOString());
    }
  }
  const activeSessionsByAdmin = new Map<string, number>();
  for (const r of activeSessionRows) {
    activeSessionsByAdmin.set(r.admin_user_id, r._count._all);
  }

  // Build a map of admin id → number of active limit rows. Used to
  // render a "Limits: N" badge so admins can spot users with limits
  // at a glance without drilling into each profile.
  const limitsByAdmin = new Map<string, number>();
  for (const l of balanceLimits) {
    limitsByAdmin.set(l.admin_user_id, (limitsByAdmin.get(l.admin_user_id) ?? 0) + 1);
  }
  const adminsWithLimits = limitsByAdmin.size;

  // Shape rows for the client table. Dates are pre-serialized to ISO
  // strings (no Date objects across the RSC boundary) and roles are
  // resolved to the effective set here so the client never re-derives it.
  const rows: AdminUserRow[] = users.map((u) => {
    const roles = getEffectiveRoles(u.role, u.roles);
    const pageKeys = u.allowed_pages.filter((p) => !p.startsWith("__can_"));
    const capabilityKeys = u.allowed_pages.filter((p) => p.startsWith("__can_"));
    return {
      id: u.id,
      username: u.username,
      displayUsername: u.display_username,
      email: u.email,
      roles,
      isActive: u.is_active,
      totpEnabled: u.totp_enabled,
      createdAt: u.created_at.toISOString(),
      lastLoginAt: lastLoginByAdmin.get(u.id) ?? null,
      activeSessions: activeSessionsByAdmin.get(u.id) ?? 0,
      // admins bypass the page list entirely — surface that explicitly
      // instead of showing "0 pages".
      isAdmin: roles.includes("admin"),
      pageAccessCount: pageKeys.length,
      capabilityCount: capabilityKeys.length,
      balanceLimitCount: limitsByAdmin.get(u.id) ?? 0,
    };
  });

  const activeCount = users.filter((u) => u.is_active).length;
  const totpCount = users.filter((u) => u.totp_enabled).length;
  const inactiveCount = users.length - activeCount;

  // Per-role tally for the by-role KPI sub. Counts each role a user holds,
  // so a multi-role user contributes to every role they have.
  const roleCounts = new Map<string, number>();
  for (const r of rows) {
    for (const role of r.roles) {
      roleCounts.set(role, (roleCounts.get(role) ?? 0) + 1);
    }
  }
  const byRoleSub = ALL_ADMIN_ROLES.map((role) => `${roleCounts.get(role) ?? 0} ${role}`)
    .filter((s) => !s.startsWith("0 "))
    .join(" · ");

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Shield}
          title="Users"
          subtitle="Staff accounts — roles, 2FA status, sessions, and activation state."
          action={
            <>
              {isCurrentUserAdmin && (
                <Button
                  variant="outline"
                  size="sm"
                  nativeButton={false}
                  render={
                    <Link href="/admin-users/balance-limits">
                      <Wallet className="mr-1.5 size-4" />
                      Balance Limits
                    </Link>
                  }
                />
              )}
              <CreateAdminDialog />
            </>
          }
        />
      </PageHero>

      <div
        className={
          isCurrentUserAdmin
            ? "grid grid-cols-2 gap-3 md:grid-cols-5"
            : "grid grid-cols-2 gap-3 md:grid-cols-4"
        }
      >
        <KpiTile
          label="Total Admins"
          value={String(users.length)}
          sub={byRoleSub || undefined}
          icon={Shield}
          accent="blue"
        />
        <KpiTile
          label="Active"
          value={String(activeCount)}
          icon={CheckCircle2}
          accent="emerald"
        />
        <KpiTile
          label="Inactive"
          value={String(inactiveCount)}
          icon={XCircle}
          accent="rose"
        />
        <KpiTile
          label="2FA Enabled"
          value={String(totpCount)}
          sub={`${users.length - totpCount} without 2FA`}
          icon={ShieldCheck}
          accent="purple"
        />
        {isCurrentUserAdmin && (
          <Link
            href="/admin-users/balance-limits"
            className="block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            aria-label="Open balance limits overview"
          >
            <KpiTile
              label="With Balance Limits"
              value={String(adminsWithLimits)}
              icon={Wallet}
              accent="amber"
            />
          </Link>
        )}
      </div>

      <div className="space-y-3">
        <SectionHeading icon={UserCog} title="All Admins" />
        <FadeIn>
          <AdminUsersTable
            rows={rows}
            isCurrentUserAdmin={isCurrentUserAdmin}
            currentUserId={session.userId}
            rolesColumnExists={rolesColumnExists}
          />
        </FadeIn>
      </div>
    </div>
  );
}
