import { Suspense } from "react";
import { getBots } from "@/lib/queries/bots";
import { requirePageAccess } from "@/lib/dal";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { BotsContent } from "./bots-content";

export default async function BotsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/bots");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const result = await getBots({
    page,
    perPage,
    search: params.search,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Bots</h1>
      <Suspense fallback={<Skeleton className="h-10 w-full" />}>
        <DataTableToolbar searchPlaceholder="Search by username..." />
      </Suspense>
      <BotsContent data={result.data} />
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </div>
  );
}
