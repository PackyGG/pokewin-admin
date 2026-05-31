import { Suspense } from "react";
import Link from "next/link";
import { Users, Ban, Archive, UserPlus } from "lucide-react";
import { getUsers, getUsersListStats } from "@/lib/queries/users";
import { requirePageAccess } from "@/lib/dal";
import { safeQuery } from "@/lib/errors/safe-query";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { adminDb } from "@/lib/admin-db";
import { ensureSupportBaseline } from "@/lib/support-baseline";
import { UsersDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatNumber } from "@/lib/utils/format";
import { ExportUsersButton } from "./export-dialog";
import { SortByNetHoldingsButton } from "./sort-net-holdings-button";
import {
  SortByPnlLosersButton,
  SortByPnlWinnersButton,
} from "./sort-pnl-buttons";

export const metadata = { title: "Users" };

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  // Self-heal: ensure every support user has /users in their
  // allowed_pages before the gate runs. Without this, an admin who
  // saves /settings/roles → Support with /users accidentally unchecked
  // can silently lock the whole support team out of the page. Runs
  // once per server process; see src/lib/support-baseline.ts.
  await ensureSupportBaseline();
  const session = await requirePageAccess("/users");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  // The "Deleted users" header button is gated by the same
  // __can_delete_user capability as the delete action itself —
  // admins always pass, non-admins only see the link when they're
  // allowed to delete. Real admins always see it; non-admins need
  // both __can_delete_user AND the /users/deleted page key.
  let canSeeDeletedUsers = session.role === "admin";
  if (!canSeeDeletedUsers) {
    const perms = await adminDb.admin_users.findUnique({
      where: { id: session.userId },
      select: { allowed_pages: true },
    });
    const pages = perms?.allowed_pages ?? [];
    canSeeDeletedUsers =
      pages.includes("/users/deleted") &&
      hasCapability(pages, "__can_delete_user");
  }

  // `getDistinctUserCountries()` used to be eager-fetched here for the
  // Export dialog's country filter. It scanned every user row to
  // collect distinct country codes — wasted work on the 95 % of page
  // loads that never open the dialog. Moved to a server action that
  // the dialog itself calls on first open (see ExportUsersButton).
  //
  // KPI stats run in PARALLEL with the table query. The two are
  // semantically independent: the table reads the filtered, paginated
  // slice; the KPI strip reads global aggregates that must stay
  // stable across page navigation + search refinements. Caching is
  // handled inside getUsersListStats (60s unstable_cache) so spamming
  // the search box doesn't fan into the DB on every keystroke.
  //
  // The KPI strip query is wrapped in safeQuery so a slow / failed
  // global aggregate doesn't block the table query — admins can still
  // browse + search users when only the strip is degraded. The table
  // query itself is the page's primary deliverable, so if it throws
  // the segment-level error.tsx takes over (intentional — there's
  // nothing usable to render without the list itself).
  const [result, statsResult] = await Promise.all([
    getUsers({
      page,
      perPage,
      search: params.search,
      role: params.role,
      status: params.status,
      sortBy: params.sortBy,
      sortOrder: params.sortOrder,
    }),
    safeQuery(() => getUsersListStats(), null, "users.listStats"),
  ]);
  const stats = statsResult.data;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Users}
          title="Users"
          subtitle="Browse, search, and filter every user on the platform."
          action={
            canSeeDeletedUsers ? (
              <Button
                variant="outline"
                size="sm"
                render={<Link href="/users/deleted" />}
              >
                <Archive className="mr-2 size-4" />
                Deleted users
              </Button>
            ) : undefined
          }
        />
      </PageHero>

      {/* KPI strip — GLOBAL aggregates (Total Users, Banned, Signups 24h)
          that read off `stats`, NOT off the paginated `result.data` slice.
          That's deliberate: admins need a stable read-out of the user
          base while they paginate or refine the table. Per-page sums
          (Net Holdings / Deposited) were removed — they shifted on every
          page click and were easy to misread as platform totals.
          Signups (24h) replaces them so the strip surfaces a real
          velocity metric instead.
          When the stats query failed (safeQuery returned null), the
          entire strip degrades to a single TileErrorFallback row instead
          of crashing the page. The table below is unaffected. */}
      {stats ? (
        <div className="grid grid-cols-3 gap-3">
          <KpiTile
            label="Total Users"
            value={formatNumber(stats.totalUsers)}
            icon={Users}
            accent="blue"
          />
          <KpiTile
            label="Banned"
            value={formatNumber(stats.totalBanned)}
            icon={Ban}
            accent="rose"
          />
          <KpiTile
            label="Signups (24h)"
            value={formatNumber(stats.signups24h)}
            icon={UserPlus}
            accent="emerald"
          />
        </div>
      ) : (
        <TileErrorFallback
          label="User stats"
          hint="The global counts query timed out. The user list below is unaffected — refresh to retry."
        />
      )}

      <div className="space-y-3">
        <SectionHeading icon={Users} title="All Users" />
        <FadeIn className="space-y-4">
          <Suspense fallback={<Skeleton className="h-10 w-full" />}>
            <DataTableToolbar
              searchPlaceholder="Search by username, email, user ID, or Discord ID..."
              filters={[
                {
                  name: "Role",
                  paramKey: "role",
                  options: [
                    { label: "Admin", value: "admin" },
                    { label: "Support", value: "support" },
                    { label: "Creator", value: "creator" },
                    { label: "User", value: "user" },
                  ],
                },
                {
                  name: "Status",
                  paramKey: "status",
                  options: [
                    { label: "Active", value: "active" },
                    { label: "Banned", value: "banned" },
                    { label: "Locked", value: "locked" },
                  ],
                },
              ]}
            >
              <SortByPnlLosersButton />
              <SortByPnlWinnersButton />
              <SortByNetHoldingsButton />
              <ExportUsersButton />
            </DataTableToolbar>
          </Suspense>
          <UsersDataTable data={result.data} />
          <DataTablePagination
            page={result.page}
            totalPages={result.totalPages}
            total={result.total}
            perPage={result.perPage}
          />
        </FadeIn>
      </div>
    </div>
  );
}
