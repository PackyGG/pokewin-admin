import { Suspense } from "react";
import Link from "next/link";
import { Users, Coins, Banknote, Ban, Archive } from "lucide-react";
import { getUsers } from "@/lib/queries/users";
import { requirePageAccess } from "@/lib/dal";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { adminDb } from "@/lib/admin-db";
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
import { formatCurrency, formatNumber } from "@/lib/utils/format";
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
  const result = await getUsers({
    page,
    perPage,
    search: params.search,
    role: params.role,
    status: params.status,
    sortBy: params.sortBy,
    sortOrder: params.sortOrder,
  });

  // KPI strip — derived ONLY from the rows already fetched for this page.
  // We deliberately do NOT issue extra aggregate queries here. The single
  // platform-wide figure we can show truthfully is the filtered total
  // (`result.total`); every money number is summed over the current page
  // and labelled "(page)" so it can't be mistaken for a platform total.
  const pageNetHoldings = result.data.reduce((sum, u) => sum + u.netHoldings, 0);
  const pageDeposited = result.data.reduce((sum, u) => sum + u.totalDeposited, 0);
  const pageBanned = result.data.filter((u) => u.status === "banned").length;

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

      {/* Net Holdings + Deposited are summed over the current page only —
          the "(page)" suffix makes the scope explicit. Net Holdings is
          orange to match the liability-toned "Net" column in the table;
          Deposited is emerald (House-POV: user capital in = house gain). */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiTile
          label="Total Users"
          value={formatNumber(result.total)}
          icon={Users}
          accent="blue"
        />
        <KpiTile
          label="Net Holdings (page)"
          value={formatCurrency(pageNetHoldings)}
          icon={Coins}
          accent="orange"
        />
        <KpiTile
          label="Deposited (page)"
          value={formatCurrency(pageDeposited)}
          icon={Banknote}
          accent="emerald"
        />
        <KpiTile
          label="Banned (page)"
          value={formatNumber(pageBanned)}
          icon={Ban}
          accent="rose"
        />
      </div>

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
