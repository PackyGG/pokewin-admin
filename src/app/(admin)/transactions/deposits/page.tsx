import { Suspense } from "react";
import { ArrowDownToLine } from "lucide-react";
import { getDepositTransactions } from "@/lib/queries/transactions";
import { requirePageAccess } from "@/lib/dal";
import { TransactionsDataTable } from "../data-table";
import { columns as depositsColumns } from "./columns";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { BigDepositsToggle } from "./big-deposits-toggle";

export const metadata = { title: "Deposits" };

export default async function DepositsTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/transactions/deposits");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  // Big-deposits filter — URL-driven so it survives refresh / page
  // navigation. Coerce defensively: NaN / negative / non-finite
  // values fall back to "no filter" (matches the toggle's default
  // when reading the same param).
  const parsedMin = Number(params.minAmount);
  const minAmount =
    Number.isFinite(parsedMin) && parsedMin > 0 ? parsedMin : undefined;
  const search = params.search;

  // Key that changes whenever the query inputs change, so the inner
  // <Suspense> remounts (re-shows the table skeleton) on pagination /
  // search / big-deposits toggle. Without this, an in-segment
  // navigation would leave a stale table on screen until the new
  // query returned — feels broken on a slow query.
  const sectionKey = `${page}|${perPage}|${search ?? ""}|${minAmount ?? ""}`;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ArrowDownToLine}
          title="Deposits"
          subtitle="All inbound deposit transactions across users."
        />
      </PageHero>

      <div className="space-y-4">
        <Suspense fallback={<Skeleton className="h-10 w-full" />}>
          <DataTableToolbar
            searchPlaceholder="Search by user ID, username, or transaction ID..."
          >
            <BigDepositsToggle />
          </DataTableToolbar>
        </Suspense>
      </div>

      <div className="space-y-3">
        <SectionHeading icon={ArrowDownToLine} title="Inbound deposits" />
        {/* getDepositTransactions is now lean — a bare index scan over
            type='deposit' plus a per-page-row LATERAL that merges the
            paired deposit_bonus. No per-user totals or cross-DB tag
            preload. We still wrap the table + pagination in <Suspense>
            so the page hero and toolbar paint immediately and the
            skeleton stays visible until the rows return, instead of
            blocking the whole route render. On an in-segment navigation
            (page change, search, toggle) the section key flips and the
            skeleton re-shows. */}
        <Suspense
          key={sectionKey}
          fallback={
            <>
              <TableSkeleton rows={Math.min(perPage, 15)} columns={6} />
              <PaginationSkeleton />
            </>
          }
        >
          <DepositsTableSection
            page={page}
            perPage={perPage}
            search={search}
            minAmount={minAmount}
          />
        </Suspense>
      </div>
    </div>
  );
}

// Extracted async section so the slow query lives inside <Suspense>
// instead of blocking the whole route. Kept colocated with the page
// — only one consumer, no reuse, splitting to a separate file would
// just add indirection.
async function DepositsTableSection({
  page,
  perPage,
  search,
  minAmount,
}: {
  page: number;
  perPage: number;
  search: string | undefined;
  minAmount: number | undefined;
}) {
  const result = await getDepositTransactions({
    page,
    perPage,
    search,
    minAmount,
  });
  return (
    <>
      <FadeIn>
        <TransactionsDataTable data={result.data} columns={depositsColumns} />
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
