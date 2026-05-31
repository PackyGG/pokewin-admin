import { Suspense } from "react";
import Link from "next/link";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ListChecks,
  Receipt,
} from "lucide-react";
import { getDepositTransactions } from "@/lib/queries/transactions";
import { getWithdrawals } from "@/lib/queries/withdrawals";
import { requirePageAccess } from "@/lib/dal";
import { TransactionsDataTable } from "../data-table";
import { columns as depositsColumns } from "./columns";
import { WithdrawalsDataTable } from "@/app/(admin)/withdrawals/data-table";
import { columns as withdrawalsColumns } from "@/app/(admin)/withdrawals/columns";
import { ValueRangeFilter } from "@/app/(admin)/withdrawals/value-range-filter";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { BigDepositsToggle } from "./big-deposits-toggle";

export const metadata = { title: "Transactions" };

// Two-tab page: Deposits (the default) and Withdrawals share the same
// "money flow" surface so admins only have one entry-point in the
// sidebar for both. The withdrawals tab embeds the same query +
// data-table + toolbar that the legacy /withdrawals page used; that
// page is now a redirect to ?tab=withdrawals so existing bookmarks
// and links keep working.
const TABS = [
  {
    value: "deposits",
    label: "Deposits",
    icon: ArrowDownToLine,
  },
  {
    value: "withdrawals",
    label: "Withdrawals",
    icon: ArrowUpFromLine,
  },
] as const;

type TabValue = (typeof TABS)[number]["value"];

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/transactions/deposits");
  const params = await searchParams;
  const tab: TabValue = params.tab === "withdrawals" ? "withdrawals" : "deposits";
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Receipt}
          title="Transactions"
          subtitle={
            tab === "deposits"
              ? "All inbound deposit transactions across users."
              : "Physical and crypto withdrawal requests — filter by status and method."
          }
        />
      </PageHero>

      {/* ── Tab switch ────────────────────────────────────────────────
          Plain Links rather than client state so the active tab survives
          page reload and admins can ⌘-click into either tab in a new
          tab. Switching tabs deliberately drops every other search
          param — the two tabs use disjoint filter sets (BigDeposits
          toggle vs Status/Method/Value-range), so carrying them
          across would either error or render the wrong filter UI.
          Mirrors the outcome-tab pattern on /transactions/upgrader. */}
      <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="inline-flex gap-1 rounded-lg bg-muted p-1">
          {TABS.map((t) => {
            const href =
              t.value === "deposits"
                ? "/transactions/deposits"
                : "/transactions/deposits?tab=withdrawals";
            return (
              <Link
                key={t.value}
                href={href}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  tab === t.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <t.icon className="size-3.5" />
                {t.label}
              </Link>
            );
          })}
        </div>
      </div>

      {tab === "deposits" ? (
        <DepositsTab page={page} perPage={perPage} params={params} />
      ) : (
        <WithdrawalsTab page={page} perPage={perPage} params={params} />
      )}
    </div>
  );
}

// ─── Deposits tab ─────────────────────────────────────────────────────
//
// Identical to the legacy /transactions/deposits surface — toolbar with
// BigDepositsToggle and the lean per-page ledger scan with paired
// deposit_bonus LATERAL. Lifted into its own helper so the tab
// switcher above stays readable.

function DepositsTab({
  page,
  perPage,
  params,
}: {
  page: number;
  perPage: number;
  params: Record<string, string | undefined>;
}) {
  // Big-deposits filter — URL-driven so it survives refresh / page
  // navigation. Coerce defensively: NaN / negative / non-finite values
  // fall back to "no filter" (matches the toggle's default when reading
  // the same param).
  const parsedMin = Number(params.minAmount);
  const minAmount =
    Number.isFinite(parsedMin) && parsedMin > 0 ? parsedMin : undefined;
  const search = params.search;

  const sectionKey = `dep|${page}|${perPage}|${search ?? ""}|${minAmount ?? ""}`;

  return (
    <>
      <div className="space-y-4">
        <Suspense fallback={<Skeleton className="h-10 w-full" />}>
          <DataTableToolbar searchPlaceholder="Search by user ID, username, or transaction ID...">
            <BigDepositsToggle />
          </DataTableToolbar>
        </Suspense>
      </div>

      <div className="space-y-3">
        <SectionHeading icon={ArrowDownToLine} title="Inbound deposits" />
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
    </>
  );
}

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

// ─── Withdrawals tab ──────────────────────────────────────────────────
//
// Same toolbar (Status + Method dropdown + ValueRangeFilter) and same
// data-table the legacy /withdrawals page used. The redirect at
// /withdrawals/page.tsx funnels old links here so bookmarks / sidebar
// crumbs / external references stay working.

function WithdrawalsTab({
  page,
  perPage,
  params,
}: {
  page: number;
  perPage: number;
  params: Record<string, string | undefined>;
}) {
  const minValue = params.minValue ? Number(params.minValue) : undefined;
  const maxValue = params.maxValue ? Number(params.maxValue) : undefined;

  const sectionKey = `wd|${page}|${perPage}|${params.status ?? ""}|${params.method ?? ""}|${params.search ?? ""}|${params.minValue ?? ""}|${params.maxValue ?? ""}`;

  return (
    <>
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
          key={sectionKey}
          fallback={
            <>
              <TableSkeleton rows={12} columns={7} />
              <PaginationSkeleton />
            </>
          }
        >
          <WithdrawalsTableSection
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
    </>
  );
}

async function WithdrawalsTableSection({
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
        <WithdrawalsDataTable columns={withdrawalsColumns} data={result.data} />
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
