import { Suspense } from "react";
import { getPacks } from "@/lib/queries/packs";
import { requirePageAccess } from "@/lib/dal";
import { PacksGrid } from "./packs-grid";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { CreatePackButton } from "./create-pack-button";

export default async function PacksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/packs");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const result = await getPacks({
    page,
    perPage,
    search: params.search,
    active: params.active,
    sortBy: params.sortBy,
    sortOrder: params.sortOrder,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-page-title">Packs</h1>
        <CreatePackButton />
      </div>
      <Suspense fallback={<Skeleton className="h-10 w-full" />}>
        <DataTableToolbar
          searchPlaceholder="Search by name or slug..."
          filters={[
            {
              name: "Status",
              paramKey: "active",
              options: [
                { label: "Active", value: "active" },
                { label: "Inactive", value: "inactive" },
              ],
            },
          ]}
        />
      </Suspense>
      <PacksGrid data={result.data} />
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </div>
  );
}
