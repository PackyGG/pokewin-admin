import { Suspense } from "react";
import { ShieldCheck, Wallet } from "lucide-react";
import Link from "next/link";
import { requirePageAccess } from "@/lib/dal";
import { Button } from "@/components/ui/button";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import {
  KpiStripSkeleton,
  SectionHeadingSkeleton,
  TableSkeleton,
} from "@/components/loading-skeletons";
import { CreateAdminDialog } from "./create-dialog";
import { AdminsAccessTabNav } from "./_components/admins-access-tab-nav";
import { AdminsTab } from "./_components/admins-tab";
import { RolesTab } from "./_roles/roles-tab";
import { parseAdminsAccessTab } from "./tabs";

export const metadata = { title: "Admins & Access" };

/**
 * Admins & Access — the unified staff-administration surface.
 *
 * Merges the former standalone /admin-users (admin accounts) and
 * /settings/roles (roles & permissions) into one tabbed page:
 *   • "Admins"              — the admin-user list + create + balance-limits.
 *   • "Roles & Permissions" — built-in role inspectors + custom-role CRUD +
 *                             the founder-only Creator-Hub access card.
 *
 * Active-Tab-Only: each tab is an async server segment behind a single
 * `<Suspense key={tab}>`, so only the active tab runs its ADMIN-DB reads.
 * Switching tabs is a `?tab=` navigation (the client tab nav), never an eager
 * dual-fetch.
 *
 * SECURITY: the page keeps its `requirePageAccess("/admin-users")` gate (a
 * non-admin custom role can hold that key). The Roles tab is ADMIN-ONLY — it
 * is hidden from non-admins in the tab nav AND the `RolesTab` segment enforces
 * `requireAdmin()` server-side, so a non-admin hitting `?tab=roles` directly is
 * redirected before any role data loads. Every role server action keeps its own
 * `requireAdmin` gate.
 */
export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePageAccess("/admin-users");
  const params = await searchParams;

  // Real-admin only: the Roles tab + the balance-limits affordances are
  // privileged. A non-admin with the /admin-users page key sees neither.
  const isCurrentUserAdmin = session.role === "admin";

  // A non-admin can never land on the Roles tab — force them to Admins even if
  // the URL says `?tab=roles` (the RolesTab segment would redirect them anyway;
  // this avoids mounting it at all).
  const requestedTab = parseAdminsAccessTab(params.tab);
  const tab =
    requestedTab === "roles" && !isCurrentUserAdmin ? "admins" : requestedTab;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ShieldCheck}
          title="Admins & Access"
          subtitle="Staff accounts, roles, and per-user permissions in one place."
          accent="blue"
          action={
            // Hero actions belong to the Admins tab (create an admin / jump to
            // balance limits). The Roles tab carries its own "New Role" action
            // in its section heading, so the hero stays clean there.
            tab === "admins" ? (
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
            ) : undefined
          }
        />
      </PageHero>

      <AdminsAccessTabNav isAdmin={isCurrentUserAdmin} />

      {/* One async segment per tab — only the active one mounts so the
          inactive tab never touches the ADMIN DB (Active-Tab-Only). */}
      <Suspense
        key={tab}
        fallback={
          <div className="space-y-6">
            <KpiStripSkeleton count={5} />
            <div className="space-y-3">
              <SectionHeadingSkeleton titleWidth={100} />
              <TableSkeleton rows={8} columns={6} />
            </div>
          </div>
        }
      >
        {tab === "roles" ? (
          <RolesTab />
        ) : (
          <AdminsTab
            isCurrentUserAdmin={isCurrentUserAdmin}
            currentUserId={session.userId}
          />
        )}
      </Suspense>
    </div>
  );
}
