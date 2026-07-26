import { Shield, CheckCircle2, XCircle, ShieldCheck, Wallet, UserCog } from "lucide-react";
import Link from "next/link";
import { sql } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { getEffectiveRoles, ALL_ADMIN_ROLES } from "@/lib/admin-roles";
import { adminRolesColumnExists } from "@/lib/admin-user-roles";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { type AdminUserRow } from "../admin-users-table";
import { AdminsList } from "../admins-list";
import { AdminsViewToggle } from "../admins-view-toggle";

/**
 * "Admins" tab content for the merged Admins & Access surface
 * (/admin-users). Renders the staff-account KPI strip + the admin-users
 * table. Lifted verbatim from the former standalone /admin-users page body
 * (only the PageHero + create/balance-limits actions moved up to the shared
 * page shell, which owns them per-tab).
 *
 * This is an async server segment mounted inside a `<Suspense>` so it only
 * runs its ADMIN-DB reads when the Admins tab is active (Active-Tab-Only).
 *
 * `isCurrentUserAdmin` / `currentUserId` are passed down from the page (which
 * already resolved the session via `requirePageAccess("/admin-users")`) so
 * this segment never re-runs the gate.
 */
export async function AdminsTab({
  isCurrentUserAdmin,
  currentUserId,
}: {
  isCurrentUserAdmin: boolean;
  currentUserId: string;
}) {
  // Explicit select — same defensive rationale as login/actions.ts. A
  // missing column from an unrun migration would otherwise crash this page
  // with 42703 before anything renders. `readAdminUsersWithRoles` degrades
  // each row to `roles: []` (→ effective `[role]`) when the additive
  // `roles` column hasn't been migrated yet.
  //
  // SECURITY: only safe, non-secret columns are selected. Never
  // password_hash, totp_secret, or recovery_codes — those stay server-side.
  const [usersResult, balanceLimitResult, rolesColumnExists, sessionsResult] = await Promise.all([
    adminDrizzle.execute<{
      id: string; email: string; username: string; display_username: string | null;
      role: string; roles: string[]; totp_enabled: boolean; is_active: boolean;
      is_owner: boolean; allowed_pages: string[]; created_at: Date;
    }>(sql`
      SELECT id::text, email, username, display_username, role::text AS role,
             roles::text[] AS roles, totp_enabled, is_active, is_owner,
             allowed_pages, created_at
      FROM admin_users
      ORDER BY created_at DESC
    `),
    isCurrentUserAdmin
      ? adminDrizzle.execute<{ admin_user_id: string; period_type: string }>(sql`
          SELECT admin_user_id, period_type::text AS period_type
          FROM admin_balance_limits
        `)
      : Promise.resolve({ rows: [] }),
    // Whether the additive `roles` column is migrated. Drives the honest
    // "multi-role needs a migration" notice in the per-row role editor.
    adminRolesColumnExists(),
    adminDrizzle.execute<{
      admin_user_id: string;
      last_login: Date | null;
      active_count: string;
    }>(sql`
      SELECT admin_user_id::text,
             MAX(logged_in_at) AS last_login,
             COUNT(*) FILTER (
               WHERE logged_out_at IS NULL AND expires_at > NOW()
             )::text AS active_count
      FROM admin_sessions
      GROUP BY admin_user_id
    `),
  ]);
  const users = usersResult.rows;
  const balanceLimits = balanceLimitResult.rows;

  // Session-derived activity per admin. One groupBy each (not N queries):
  //   • lastLogin  — max(logged_in_at) per user → "Last login" column.
  //   • activeNow  — count of sessions that are NOT logged out and not
  //                  expired → "active sessions" indicator. Mirrors the
  //                  isActive derivation in getAdminUserSessions.
  const lastLoginByAdmin = new Map<string, string>();
  for (const r of sessionsResult.rows) {
    if (r.last_login) {
      lastLoginByAdmin.set(r.admin_user_id, r.last_login.toISOString());
    }
  }
  const activeSessionsByAdmin = new Map<string, number>();
  for (const r of sessionsResult.rows) {
    activeSessionsByAdmin.set(r.admin_user_id, Number(r.active_count));
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
    // Effective owner state for the badge: the `is_owner` column (absent on a
    // pre-migration DB → false) OR the permanent `motha` username. The narrowed
    // type from readAdminUsersWithRoles may omit `is_owner`, so read defensively.
    const ownerCol = (u as { is_owner?: boolean | null }).is_owner ?? false;
    const isOwner =
      ownerCol || (u.username ?? "").trim().toLowerCase() === "motha";
    return {
      id: u.id,
      username: u.username,
      displayUsername: u.display_username,
      email: u.email,
      roles,
      isActive: u.is_active,
      totpEnabled: u.totp_enabled,
      isOwner,
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
        <SectionHeading
          icon={UserCog}
          title="All Admins"
          action={<AdminsViewToggle />}
        />
        <FadeIn>
          <AdminsList
            rows={rows}
            isCurrentUserAdmin={isCurrentUserAdmin}
            currentUserId={currentUserId}
            rolesColumnExists={rolesColumnExists}
          />
        </FadeIn>
      </div>
    </div>
  );
}
