import { Suspense } from "react";
import { ArrowUpFromLine } from "lucide-react";
import { getWithdrawals } from "@/lib/queries/withdrawals";
import { requirePageAccess } from "@/lib/dal";
import { WithdrawalsDataTable } from "./data-table";
import { columns } from "./columns";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { ValueRangeFilter } from "./value-range-filter";
import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton, PaginationSkeleton } from "@/components/loading-skeletons";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { ListChecks } from "lucide-react";

export const metadata = { title: "Withdrawals" };

/**
 * Streaming server component for the withdrawals table. Pulled out of the
 * page-level await so the hero + toolbar can flush immediately while the
 * (potentially heavy) join-with-user query loads.
 */
async function WithdrawalsContent({
  page,
  perPage,
  status,
  method,
  search,
  minValue,
  maxValue,
}: {
  page: number;
  perPage: number;
  status?: string;
  method?: string;
  search?: string;
  minValue?: number;
  maxValue?: number;
}) {
  const result = await getWithdrawals({
    page,
    perPage,
    status,
    method,
    search,
    minValue: minValue && !isNaN(minValue) ? minValue : undefined,
    maxValue: maxValue && !isNaN(maxValue) ? maxValue : undefined,
  });

  return (
    <>
      <FadeIn>
        <WithdrawalsDataTable columns={columns} data={result.data} />
      </FadeIn>
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </>
  );
}

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

  const suspenseKey = `${page}|${perPage}|${params.status ?? ""}|${params.method ?? ""}|${params.search ?? ""}|${params.minValue ?? ""}|${params.maxValue ?? ""}`;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ArrowUpFromLine}
          title="Withdrawals"
          subtitle="Physical and crypto withdrawal requests — filter by status and method."
        />
      </PageHero>

      <div className="space-y-4">
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
      </div>

      <div className="space-y-3">
        <SectionHeading icon={ListChecks} title="Withdrawal requests" />
        <Suspense
          key={suspenseKey}
          fallback={
            <>
              <TableSkeleton rows={12} columns={7} />
              <PaginationSkeleton />
            </>
          }
        >
          <WithdrawalsContent
            page={page}
            perPage={perPage}
            status={params.status}
            method={params.method}
            search={params.search}
            minValue={minValue}
            maxValue={maxValue}
          />
        </Suspense>
      </div>
    </div>
  );
}
