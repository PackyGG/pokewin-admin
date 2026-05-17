import { Suspense } from "react";
import { Users } from "lucide-react";
import { getUsers } from "@/lib/queries/users";
import { requirePageAccess } from "@/lib/dal";
import { UsersDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHero } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
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

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Users className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Users</h1>
            <p className="text-sm text-muted-foreground">
              Browse, search, and filter every user on the platform.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="space-y-4">
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
        <FadeIn>
          <UsersDataTable data={result.data} />
        </FadeIn>
        <DataTablePagination
          page={result.page}
          totalPages={result.totalPages}
          total={result.total}
          perPage={result.perPage}
        />
      </div>
    </div>
  );
}
