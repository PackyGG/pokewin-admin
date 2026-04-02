import { Suspense } from "react";
import { getWhitelistUsers } from "@/lib/queries/whitelist";
import { requirePageAccess } from "@/lib/dal";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { WhitelistContent } from "./whitelist-content";

export default async function WhitelistPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/whitelist");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const result = await getWhitelistUsers({
    page,
    perPage,
    search: params.search,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Whitelist</h1>
      <Suspense fallback={<Skeleton className="h-10 w-full" />}>
        <DataTableToolbar searchPlaceholder="Search by username or Discord ID..." />
      </Suspense>
      <WhitelistContent data={result.data} />
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </div>
  );
}
