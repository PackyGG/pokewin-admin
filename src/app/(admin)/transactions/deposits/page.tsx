import { Suspense } from "react";
import { getDepositTransactions } from "@/lib/queries/transactions";
import { requirePageAccess } from "@/lib/dal";
import { TransactionsDataTable } from "../data-table";
import { columns as depositsColumns } from "./columns";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";

export default async function DepositsTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/transactions/deposits");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const result = await getDepositTransactions({
    page,
    perPage,
    search: params.search,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Deposits</h1>
      <Suspense fallback={<Skeleton className="h-10 w-full" />}>
        <DataTableToolbar
          searchPlaceholder="Search by user ID, username, or transaction ID..."
        />
      </Suspense>
      <TransactionsDataTable data={result.data} columns={depositsColumns} />
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </div>
  );
}
