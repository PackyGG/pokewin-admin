import { Suspense } from "react";
import { getCodes } from "@/lib/queries/creators";
import { requirePageAccess } from "@/lib/dal";
import { CodesDataTable } from "./data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";

export default async function CodesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/creators/codes");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const result = await getCodes({
    page,
    perPage,
    search: params.search,
    sortBy: params.sortBy,
    sortOrder: params.sortOrder,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Affiliate Codes</h1>
      <Suspense fallback={<Skeleton className="h-10 w-full" />}>
        <DataTableToolbar searchPlaceholder="Search by code or username..." />
      </Suspense>
      <CodesDataTable data={result.data} />
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </div>
  );
}
