import { Suspense } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  ListChecks,
  Receipt,
} from "lucide-react";
import { getDepositTransactions } from "@/lib/queries/transactions";
import { getWithdrawals } from "@/lib/queries/withdrawals";
import { requirePageAccess } from "@/lib/dal";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
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
import { LinkPendingShell } from "@/components/ux";
import { AutoRefresh } from "@/app/(admin)/dashboard/auto-refresh";
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

/** Withdrawals sub-views — default is open queue (pending + processing). */
const WITHDRAWAL_VIEWS = [
  { value: "open", label: "Open requests" },
  { value: "all", label: "All" },
] as const;

type WithdrawalView = (typeof WITHDRAWAL_VIEWS)[number]["value"];

function resolveWithdrawalView(params: Record<string, string | undefined>): WithdrawalView {
  if (params.view === "all") return "all";
  return "open";
}

function buildWithdrawalsTabHref(
  view: WithdrawalView,
  params: Record<string, string | undefined>,
): string {
  const next = new URLSearchParams();
  next.set("tab", "withdrawals");
  if (view === "all") next.set("view", "all");
  if (params.status) next.set("status", params.status);
  if (params.method) next.set("method", params.method);
  if (params.search) next.set("search", params.search);
  if (params.minValue) next.set("minValue", params.minValue);
  if (params.maxValue) next.set("maxValue", params.maxValue);
  if (params.perPage) next.set("perPage", params.perPage);
  const qs = next.toString();
  return `/transactions/deposits?${qs}`;
}

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/transactions/deposits");
  const params = await searchParams;
  const tab: TabValue = params.tab === "withdrawals" ? "withdrawals" : "deposits";
  const withdrawalView = resolveWithdrawalView(params);
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  return (
    <div className="space-y-6">
      {/* Periodic server refresh so the active tab's list stays fresh
          without a manual reload. router.refresh() re-runs ONLY the
          rendered route segment — i.e. the active tab's query — so the
          hidden tab is never fetched by the refresh either. 60s matches
          the list query's unstable_cache revalidate window. The
          component itself skips the refresh when the tab is
          backgrounded. */}
      <AutoRefresh intervalMs={60_000} />
      <PageHero>
        <PageHeroIdentity
          icon={Receipt}
          title="Transactions"
          subtitle={
            tab === "deposits"
              ? "All inbound deposit transactions across users."
              : withdrawalView === "open"
                ? "Pending and processing withdrawal requests — the open queue."
                : "All physical and crypto withdrawal requests — filter by status and method."
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
          Mirrors the outcome-tab pattern on /transactions/upgrader.

          `prefetch={false}` is what makes this Active-Tab-Only: without
          it Next.js prefetches the INACTIVE tab's route segment on
          hover / viewport-enter, which runs that tab's list query
          (deposits OR withdrawals) before the admin ever clicks it — so
          the page would effectively fetch BOTH tabs' data up front. With
          prefetch off, the hidden tab's query only fires on the actual
          click, into its own `<Suspense>` boundary below. `replace` +
          `scroll={false}` mirror the Insights lazy-tab switch so the
          back button skips intermediate tab states and the viewport
          doesn't jump on switch. */}
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
                replace
                scroll={false}
                prefetch={false}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  tab === t.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <LinkPendingShell spinnerSize={13}>
                  <t.icon className="size-3.5" />
                  {t.label}
                </LinkPendingShell>
              </Link>
            );
          })}
        </div>
      </div>

      {tab === "deposits" ? (
        <DepositsTab page={page} perPage={perPage} params={params} />
      ) : (
        <WithdrawalsTab
          page={page}
          perPage={perPage}
          params={params}
          view={withdrawalView}
        />
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
  // Empty shape getDepositTransactions returns for zero rows — the
  // safeQuery fallback, so the table + pagination still paint (degraded)
  // on failure.
  const EMPTY_LIST: Awaited<ReturnType<typeof getDepositTransactions>> = {
    data: [],
    total: 0,
    page,
    perPage,
    totalPages: 0,
  };

  // safeQuery (house 15s wall-clock bound) degrades a failed/hung list
  // query to an empty table + a VISIBLE amber band — hero, tabs, toolbar
  // and pagination keep rendering so the admin can clear filters or retry.
  // Identical to the bare await on the happy path.
  const listResult = await safeQuery(
    () =>
      getDepositTransactions({
        page,
        perPage,
        search,
        minAmount,
      }),
    EMPTY_LIST,
    "transactions.deposits.list",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const result = listResult.data;
  const listFailed = listResult.error !== null;

  return (
    <>
      {listFailed && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
        >
          <AlertTriangle
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-amber-500"
          />
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Couldn&apos;t load deposits — the query timed out or failed. This
            is a{" "}
            <span className="font-medium">query error, not zero results</span>
            . Refresh to retry, or clear the search and amount filter.
          </p>
        </div>
      )}
      <FadeIn>
        <TransactionsDataTable data={result.data} columns={depositsColumns} />
      </FadeIn>
      <FadeIn speed="fast">
        <DataTablePagination
          page={result.page}
          totalPages={result.totalPages}
          total={result.total}
          perPage={result.perPage}
          degraded={listFailed}
        />
      </FadeIn>
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
  view,
}: {
  page: number;
  perPage: number;
  params: Record<string, string | undefined>;
  view: WithdrawalView;
}) {
  const minValue = params.minValue ? Number(params.minValue) : undefined;
  const maxValue = params.maxValue ? Number(params.maxValue) : undefined;

  const sectionKey = `wd|${view}|${page}|${perPage}|${params.status ?? ""}|${params.method ?? ""}|${params.search ?? ""}|${params.minValue ?? ""}|${params.maxValue ?? ""}`;

  return (
    <>
      <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="inline-flex gap-1 rounded-lg bg-muted/60 p-1">
          {WITHDRAWAL_VIEWS.map((v) => (
            <Link
              key={v.value}
              href={buildWithdrawalsTabHref(v.value, params)}
              replace
              scroll={false}
              prefetch={false}
              className={cn(
                "inline-flex shrink-0 items-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors sm:text-sm",
                view === v.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v.label}
            </Link>
          ))}
        </div>
      </div>

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
        <SectionHeading
          icon={ListChecks}
          title={view === "open" ? "Open withdrawal requests" : "All withdrawals"}
        />
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
            view={view}
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
  view,
  status,
  method,
  search,
  minValue,
  maxValue,
}: {
  page: number;
  perPage: number;
  view: WithdrawalView;
  status?: string;
  method?: string;
  search?: string;
  minValue?: number;
  maxValue?: number;
}) {
  // Default open queue = pending + processing (matches legacy /withdrawals
  // "Withdrawal Requests" tab). An explicit Status filter overrides it.
  const statuses =
    status && status !== "all"
      ? undefined
      : view === "open"
        ? (["pending", "processing"] as const)
        : undefined;
  const statusFilter = status && status !== "all" ? status : undefined;

  // Empty shape getWithdrawals returns for zero rows — the safeQuery
  // fallback, so the table + pagination still paint (degraded) on failure.
  const EMPTY_LIST: Awaited<ReturnType<typeof getWithdrawals>> = {
    data: [],
    total: 0,
    page,
    perPage,
    totalPages: 0,
  };

  // safeQuery (house 15s wall-clock bound) degrades a failed/hung list
  // query to an empty table + a VISIBLE amber band — hero, tabs, toolbar
  // and pagination keep rendering so the admin can clear filters or retry.
  // Identical to the bare await on the happy path.
  const listResult = await safeQuery(
    () =>
      getWithdrawals({
        page,
        perPage,
        status: statusFilter,
        statuses: statuses ? [...statuses] : undefined,
        method,
        search,
        minValue: minValue && !isNaN(minValue) ? minValue : undefined,
        maxValue: maxValue && !isNaN(maxValue) ? maxValue : undefined,
      }),
    EMPTY_LIST,
    "transactions.withdrawals.list",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const result = listResult.data;
  const listFailed = listResult.error !== null;

  return (
    <>
      {listFailed && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
        >
          <AlertTriangle
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-amber-500"
          />
          <p className="text-xs text-amber-700 dark:text-amber-300">
            Couldn&apos;t load withdrawals — the query timed out or failed.
            This is a{" "}
            <span className="font-medium">query error, not zero results</span>
            . Refresh to retry, or clear the status / method / value filters.
          </p>
        </div>
      )}
      <FadeIn>
        <WithdrawalsDataTable columns={withdrawalsColumns} data={result.data} />
      </FadeIn>
      <FadeIn speed="fast">
        <DataTablePagination
          page={result.page}
          totalPages={result.totalPages}
          total={result.total}
          perPage={result.perPage}
          degraded={listFailed}
        />
      </FadeIn>
    </>
  );
}
