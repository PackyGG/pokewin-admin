import Link from "next/link";
import { Shield, CheckCircle2, XCircle, ShieldCheck, Wallet } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { adminDb } from "@/lib/admin-db";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/utils/format";
import { AdminUserActions } from "./admin-user-actions";
import { CreateAdminDialog } from "./create-dialog";
import {
  PageHero,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Admin Users" };

export default async function AdminUsersPage() {
  const session = await requirePageAccess("/admin-users");
  // Surface balance-limit info only to real admins. Non-admins with
  // /admin-users access (custom role) should not see who is or isn't
  // limited — that's privileged information about other admins.
  const isCurrentUserAdmin = session.role === "admin";

  // Explicit select — same defensive rationale as login/actions.ts. A
  // missing column from an unrun migration would otherwise crash this page
  // with P2022 before anything renders.
  const [users, balanceLimits] = await Promise.all([
    adminDb.admin_users.findMany({
      orderBy: { created_at: "desc" },
      select: {
        id: true,
        email: true,
        username: true,
        role: true,
        totp_enabled: true,
        is_active: true,
        created_at: true,
      },
    }),
    isCurrentUserAdmin
      ? adminDb.admin_balance_limits.findMany({
          select: { admin_user_id: true, period_type: true },
        })
      : Promise.resolve([]),
  ]);

  // Build a map of admin id → number of active limit rows. Used to
  // render a "Limits: N" badge so admins can spot users with limits
  // at a glance without drilling into each profile.
  const limitsByAdmin = new Map<string, number>();
  for (const l of balanceLimits) {
    limitsByAdmin.set(l.admin_user_id, (limitsByAdmin.get(l.admin_user_id) ?? 0) + 1);
  }
  const adminsWithLimits = limitsByAdmin.size;

  const activeCount = users.filter((u) => u.is_active).length;
  const totpCount = users.filter((u) => u.totp_enabled).length;
  const inactiveCount = users.length - activeCount;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
              <Shield className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">Admin Users</h1>
              <p className="text-sm text-muted-foreground">
                Staff accounts — roles, 2FA status, and activation state.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isCurrentUserAdmin && (
              <Button
                variant="outline"
                size="sm"
                render={
                  <Link href="/admin-users/balance-limits">
                    <Wallet className="mr-1.5 size-4" />
                    Balance Limits
                  </Link>
                }
              />
            )}
            <CreateAdminDialog />
          </div>
        </div>
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
          icon={ShieldCheck}
          accent="purple"
        />
        {isCurrentUserAdmin && (
          <Link
            href="/admin-users/balance-limits"
            className="block transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-xl"
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
        <SectionHeading icon={Shield} title="All Admins" />
        <FadeIn className="rounded-md border overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="px-4 py-3 text-left text-sm font-medium">Username</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Email</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Role</th>
                <th className="px-4 py-3 text-left text-sm font-medium">2FA</th>
                <th className="px-4 py-3 text-left text-sm font-medium">Status</th>
                {isCurrentUserAdmin && (
                  <th className="px-4 py-3 text-left text-sm font-medium">Limits</th>
                )}
                <th className="px-4 py-3 text-left text-sm font-medium">Created</th>
                <th className="px-4 py-3 text-right text-sm font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr key={user.id} className="border-b last:border-b-0">
                  <td className="px-4 py-3 text-sm font-medium">
                    <Link
                      href={`/admin-users/${user.id}`}
                      className="text-blue-400 hover:underline"
                    >
                      {user.username}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {user.email}
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="outline" className="text-xs uppercase">
                      {user.role}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant="outline"
                      className={
                        user.totp_enabled
                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                          : "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30"
                      }
                    >
                      {user.totp_enabled ? "Enabled" : "Not set up"}
                    </Badge>
                  </td>
                  <td className="px-4 py-3">
                    <Badge
                      variant="outline"
                      className={
                        user.is_active
                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                          : "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30"
                      }
                    >
                      {user.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </td>
                  {isCurrentUserAdmin && (
                    <td className="px-4 py-3">
                      {limitsByAdmin.has(user.id) ? (
                        <Link
                          href={`/admin-users/${user.id}#balance-limits`}
                          className="inline-block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded-md"
                        >
                          <Badge
                            variant="outline"
                            className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30 cursor-pointer hover:bg-amber-500/25"
                          >
                            {limitsByAdmin.get(user.id)} cap
                            {limitsByAdmin.get(user.id) === 1 ? "" : "s"}
                          </Badge>
                        </Link>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                  )}
                  <td className="px-4 py-3 text-sm text-muted-foreground">
                    {formatDateTime(user.created_at.toISOString())}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <AdminUserActions
                      userId={user.id}
                      isActive={user.is_active}
                      totpEnabled={user.totp_enabled}
                      role={user.role}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </FadeIn>
      </div>
    </div>
  );
}
