import { Suspense } from "react";
import Link from "next/link";
import { AlertTriangle, Gift } from "lucide-react";
import { getTransactions } from "@/lib/queries/transactions";
import { requirePageAccess } from "@/lib/dal";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import { TransactionsDataTable } from "../data-table";
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

export const metadata = { title: "Reward Transactions" };

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const TYPES = [
  "rakeback_claim",
  "race_prize",
  "balance_reward_claim",
  "reward_card_sale",
];

export default async function RewardTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/transactions/rewards");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const tab = params.tab || "all";

  const suspenseKey = `${tab}|${page}|${perPage}|${params.search ?? ""}`;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Gift}
          title="Reward Transactions"
          subtitle="Rakeback claims, race prizes, and reward-card sales."
        />
      </PageHero>

      <div className="space-y-4">
        <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="inline-flex gap-1 rounded-lg bg-muted p-1">
            {STATUS_TABS.map((t) => (
              <Link
                key={t.value}
                href={`/transactions/rewards?tab=${t.value}`}
                className={cn(
                  "shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  tab === t.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <LinkPendingShell spinnerSize={13}>{t.label}</LinkPendingShell>
              </Link>
            ))}
          </div>
        </div>
        <Suspense fallback={<Skeleton className="h-10 w-full" />}>
          <DataTableToolbar
            searchPlaceholder="Search by user ID, username, or transaction ID..."
          />
        </Suspense>
      </div>

      <div className="space-y-3">
        <SectionHeading icon={Gift} title="Reward payouts" />
        {/* Same streaming pattern as /transactions/deposits — the
            ledger query gates the table, but the rest of the page can
            paint immediately while it runs. */}
        <Suspense
          key={suspenseKey}
          fallback={
            <>
              <TableSkeleton rows={Math.min(perPage, 15)} columns={6} />
              <PaginationSkeleton />
            </>
          }
        >
          <RewardTxTableSection
            page={page}
            perPage={perPage}
            tab={tab}
            search={params.search}
          />
        </Suspense>
      </div>
    </div>
  );
}

async function RewardTxTableSection({
  page,
  perPage,
  tab,
  search,
}: {
  page: number;
  perPage: number;
  tab: string;
  search: string | undefined;
}) {
  // Empty shape getTransactions returns for zero rows — the safeQuery
  // fallback, so the table + pagination still paint (degraded) on failure.
  const EMPTY_LIST: Awaited<ReturnType<typeof getTransactions>> = {
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
      getTransactions({
        page,
        perPage,
        search,
        types: TYPES,
        status: tab === "all" ? undefined : tab,
      }),
    EMPTY_LIST,
    "transactions.rewards.list",
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
            Couldn&apos;t load reward transactions — the query timed out or
            failed. This is a{" "}
            <span className="font-medium">query error, not zero results</span>
            . Refresh to retry, or clear the search.
          </p>
        </div>
      )}
      <FadeIn>
        <TransactionsDataTable data={result.data} />
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
