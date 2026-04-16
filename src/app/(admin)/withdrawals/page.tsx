import { Suspense } from "react";
import { getWithdrawals } from "@/lib/queries/withdrawals";
import { requirePageAccess } from "@/lib/dal";
import { WithdrawalsDataTable } from "./data-table";
import { columns } from "./columns";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { ValueRangeFilter } from "./value-range-filter";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata = { title: "Withdrawals" };

export default async function WithdrawalsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/withdrawals");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const minValue = params.minValue ? Number(params.minValue) : undefined;
  const maxValue = params.maxValue ? Number(params.maxValue) : undefined;

  // Single-page Withdrawals view — the old tabs (Requests / Shipping /
  // Active / Finished / All) are gone. Everything is one list; admins
  // filter via the Status + Method dropdowns in the toolbar, same
  // pattern the Deposits page uses.
  const result = await getWithdrawals({
    page,
    perPage,
    status: params.status,
    method: params.method,
    search: params.search,
    minValue: minValue && !isNaN(minValue) ? minValue : undefined,
    maxValue: maxValue && !isNaN(maxValue) ? maxValue : undefined,
  });

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Withdrawals</h1>
      <Suspense fallback={<Skeleton className="h-10 w-full" />}>
        <DataTableToolbar
          searchPlaceholder="Search by ID or username..."
          filters={[
            {
              name: "Status",
              paramKey: "status",
              options: [
                { label: "Pending", value: "pending" },
                { label: "Processing", value: "processing" },
                { label: "Shipped", value: "shipped" },
                { label: "Completed", value: "completed" },
                { label: "Cancelled", value: "cancelled" },
                { label: "Failed", value: "failed" },
              ],
            },
            {
              name: "Method",
              paramKey: "method",
              options: [
                { label: "Physical", value: "physical" },
                { label: "Crypto", value: "crypto" },
              ],
            },
          ]}
        >
          <ValueRangeFilter />
        </DataTableToolbar>
      </Suspense>
      <WithdrawalsDataTable columns={columns} data={result.data} />
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </div>
  );
}
