import { Suspense } from "react";
import { ArrowUpFromLine, ListChecks } from "lucide-react";

import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { FadeIn } from "@/components/fade-in";
import { PaginationSkeleton, TableSkeleton } from "@/components/loading-skeletons";
import { PageHero, PageHeroIdentity, SectionHeading } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { requirePageAccess } from "@/lib/dal";
import { getWithdrawals } from "@/lib/queries/withdrawals";
import { parsePage, parsePerPage } from "@/lib/utils/pagination";
import { columns } from "./columns";
import { WithdrawalsDataTable } from "./data-table";
import { ValueRangeFilter } from "./value-range-filter";

export const metadata = { title: "Withdrawals" };

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
    minValue: minValue && Number.isFinite(minValue) ? minValue : undefined,
    maxValue: maxValue && Number.isFinite(maxValue) ? maxValue : undefined,
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
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePageAccess("/withdrawals");
  const raw = await searchParams;
  const value = (key: string) => {
    const entry = raw[key];
    return Array.isArray(entry) ? entry[0] : entry;
  };
  const page = parsePage(value("page"));
  const perPage = parsePerPage(value("perPage"));
  const minValue = value("minValue") ? Number(value("minValue")) : undefined;
  const maxValue = value("maxValue") ? Number(value("maxValue")) : undefined;
  const suspenseKey = `${page}|${perPage}|${value("status") ?? ""}|${value("method") ?? ""}|${value("search") ?? ""}|${value("minValue") ?? ""}|${value("maxValue") ?? ""}`;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <div className="space-y-1">
        <SectionHeading icon={ArrowUpFromLine} title="Withdrawals" />
        <p className="text-sm text-muted-foreground">
          Physical and crypto withdrawal requests, kept separate from Fiat
          credit reviews.
        </p>
      </div>

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
            status={value("status")}
            method={value("method")}
            search={value("search")}
            minValue={minValue}
            maxValue={maxValue}
          />
        </Suspense>
      </div>
    </div>
  );
}
