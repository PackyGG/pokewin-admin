import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CreditCard,
  DatabaseZap,
  ListChecks,
} from "lucide-react";
import { getDepositTransactions } from "@/lib/queries/transactions";
import { getCardPayments } from "@/lib/queries/card-payments";
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
import { parsePage, parsePerPage } from "@/lib/utils/pagination";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { LinkPendingShell } from "@/components/ux";
import { BigDepositsToggle } from "./big-deposits-toggle";
import { CardPaymentsTable } from "./card-payments-table";

export const metadata = { title: "Transactions" };

// Deposits, card payments, and withdrawals share the same "money flow"
// surface so admins only have one entry-point in the sidebar for all
// three. The withdrawals tab embeds the same query + data-table +
// toolbar the standalone /withdrawals page uses; that page stays live
// as its own permission-gated route, this tab is the combined view.
//
// Fiat CREDIT REVIEWS are deliberately NOT here — that queue lives in
// the Fraud workspace (/antifraud/fiat-deposits). This page is the
// read-only money-flow ledger; it approves nothing. The retired
// ?tab=fiat-fraud / ?tab=refunds deep links are redirected to Fraud at
// the HTTP layer in `src/middleware.ts` (an in-render redirect to a
// different origin makes React attempt a cross-origin RSC navigation
// and crash with #310).
const TABS = [
  {
    value: "deposits",
    label: "Deposits",
    icon: ArrowDownToLine,
  },
  {
    value: "card-payments",
    label: "Card Payments",
    icon: CreditCard,
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
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // DAL gate first — house rule: no work before the page-access check.
  await requirePageAccess("/transactions/deposits");

  const rawParams = await searchParams;
  const firstValue = (key: string) => {
    const raw = rawParams[key];
    return Array.isArray(raw) ? raw[0] : raw;
  };

  const params = Object.fromEntries(
    Object.keys(rawParams).map((key) => [key, firstValue(key)]),
  ) as Record<string, string | undefined>;
  const tab: TabValue =
    params.tab === "withdrawals"
      ? "withdrawals"
      : params.tab === "card-payments"
        ? "card-payments"
        : "deposits";
  // Clamped parsing — `Number(x) || 1` would let ?page=1e12 reach SQL as an
  // OFFSET ≈ 2e13 index walk and ?perPage=1e6 dump the table into the RSC
  // payload. parsePage/parsePerPage bound both for all three tabs.
  const page = parsePage(params.page);
  const perPage = parsePerPage(params.perPage);

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
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
                : `/transactions/deposits?tab=${t.value}`;
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
      ) : tab === "card-payments" ? (
        <CardPaymentsTab page={page} perPage={perPage} params={params} />
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
        <MirrorUnavailableNotice
          message={
            <>
              Couldn&apos;t load deposits — the query timed out or failed.
              This is a{" "}
              <span className="font-medium">
                query error, not zero results
              </span>
              . Refresh to retry, or clear the search and amount filter.
            </>
          }
        />
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

function CardPaymentsTab({
  page,
  perPage,
  params,
}: {
  page: number;
  perPage: number;
  params: Record<string, string | undefined>;
}) {
  const sectionKey = `card|${page}|${perPage}|${params.status ?? ""}|${params.search ?? ""}`;

  return (
    <>
      <div className="space-y-4">
        <Suspense fallback={<Skeleton className="h-10 w-full" />}>
          <DataTableToolbar
            searchPlaceholder="Search user, intent, checkout, or payment ID..."
            filters={[
              {
                name: "Status",
                paramKey: "status",
                options: [
                  { label: "Created", value: "created" },
                  { label: "Checkout creating", value: "checkout_creating" },
                  { label: "Checkout ready", value: "checkout_ready" },
                  { label: "Pending", value: "pending" },
                  { label: "Completed", value: "completed" },
                  { label: "Review", value: "review" },
                  { label: "Failed", value: "failed" },
                  { label: "Canceled", value: "canceled" },
                  { label: "Partially refunded", value: "partially_refunded" },
                  { label: "Refunded", value: "refunded" },
                  { label: "Disputed", value: "disputed" },
                ],
              },
            ]}
          />
        </Suspense>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SectionHeading icon={CreditCard} title="Card payments" />
          <div className="inline-flex items-center gap-1.5 rounded-full border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
            <DatabaseZap className="size-3" />
            PostgreSQL
          </div>
        </div>
        <Suspense
          key={sectionKey}
          fallback={
            <>
              <TableSkeleton rows={Math.min(perPage, 15)} columns={8} />
              <PaginationSkeleton />
            </>
          }
        >
          <CardPaymentsTableSection
            page={page}
            perPage={perPage}
            search={params.search}
            status={params.status}
          />
        </Suspense>
      </div>
    </>
  );
}

async function CardPaymentsTableSection({
  page,
  perPage,
  search,
  status,
}: {
  page: number;
  perPage: number;
  search?: string;
  status?: string;
}) {
  const empty = {
    data: [],
    total: 0,
    page,
    perPage,
    totalPages: 0,
  } satisfies Awaited<ReturnType<typeof getCardPayments>>;

  const listResult = await safeQuery(
    () => getCardPayments({ page, perPage, search, status }),
    empty,
    "transactions.card-payments.list",
    REWARD_QUERY_TIMEOUT_MS,
  );

  return (
    <>
      {listResult.error && (
        <MirrorUnavailableNotice message="Card-payment data could not be loaded from PostgreSQL. Refresh to retry." />
      )}
      <FadeIn>
        <CardPaymentsTable data={listResult.data.data} />
      </FadeIn>
      <FadeIn speed="fast">
        <DataTablePagination
          page={listResult.data.page}
          totalPages={listResult.data.totalPages}
          total={listResult.data.total}
          perPage={listResult.data.perPage}
          degraded={listResult.error !== null}
        />
      </FadeIn>
    </>
  );
}

// Shared amber failure band for all three tabs — one markup source so the
// degraded-state styling can't drift between deposits / card payments /
// withdrawals. `message` accepts JSX so callers can keep emphasis spans.
function MirrorUnavailableNotice({ message }: { message: ReactNode }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
    >
      <AlertTriangle
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-amber-500"
      />
      <p className="text-xs text-amber-700 dark:text-amber-300">{message}</p>
    </div>
  );
}

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
        <SectionHeading icon={ListChecks} title="All withdrawals" />
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
  // Single merged view: ALL withdrawal statuses by default. The admin
  // narrows the list with the Status dropdown (pending / processing /
  // shipped / completed / cancelled / failed) when needed — there is no
  // pre-filtered "open queue" anymore.
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
        <MirrorUnavailableNotice
          message={
            <>
              Couldn&apos;t load withdrawals — the query timed out or failed.
              This is a{" "}
              <span className="font-medium">
                query error, not zero results
              </span>
              . Refresh to retry, or clear the status / method / value
              filters.
            </>
          }
        />
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
