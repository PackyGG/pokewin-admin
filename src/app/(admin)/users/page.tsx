import { Suspense } from "react";
import { Users, Coins, Banknote, Ban } from "lucide-react";
import { getUsers } from "@/lib/queries/users";
import { requirePageAccess } from "@/lib/dal";
import { UsersDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
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

export const metadata = { title: "Users" };

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/users");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

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
