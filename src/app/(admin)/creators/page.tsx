import { Suspense } from "react";
import { getCreators, searchNonCreatorUsers } from "@/lib/queries/creators";
import { requirePageAccess } from "@/lib/dal";
import { CreatorsDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { UserSearchResults } from "./user-search-results";

export const metadata = { title: "Creators" };

export default async function CreatorsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/creators");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const [result, nonCreators] = await Promise.all([
    getCreators({
      page,
      perPage,
      search: params.search,
      sortBy: params.sortBy,
      sortOrder: params.sortOrder,
    }),
    params.search ? searchNonCreatorUsers(params.search) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-4">
      <h1 className="text-page-title">Creators</h1>
      <Suspense fallback={<Skeleton className="h-10 w-full" />}>
        <DataTableToolbar searchPlaceholder="Search by code or username..." />
      </Suspense>
      <CreatorsDataTable data={result.data} />
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
      {nonCreators.length > 0 && <UserSearchResults users={nonCreators} />}
    </div>
  );
}
