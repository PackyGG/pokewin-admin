import { Suspense } from "react";
import Link from "next/link";
import { ArrowUpCircle } from "lucide-react";
import { getUpgraderTransactions } from "@/lib/queries/upgrader-transactions";
import { requirePageAccess } from "@/lib/dal";
import { UpgraderTransactionsDataTable } from "./data-table";
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

export const metadata = { title: "Upgrader Transactions" };

/**
 * Outcome tabs — derived from `upgrader_games.won_amount`:
 *   • all   — every game (wins + losses)
 *   • win   — won_amount > 0 (user took money out → house loss)
 *   • loss  — won_amount = 0 (player risked, house kept it all)
 *
 * Mirrors the status-tab UX of the sibling /transactions sub-pages but
 * uses outcome instead of ledger status because the upgrader_games
 * table doesn't carry a pending/completed/failed lifecycle — every
 * row is a settled game.
 */
const OUTCOME_TABS = [
  { value: "all", label: "All" },
  { value: "win", label: "Wins" },
  { value: "loss", label: "Losses" },
];

export default async function UpgraderTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/transactions/upgrader");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const tab = params.tab || "all";

  // Suspense key — flips when any input changes so the table skeleton
  // re-shows on in-segment navigation instead of leaving stale rows on
  // screen during a slow refetch.
  const suspenseKey = `${tab}|${page}|${perPage}|${params.search ?? ""}`;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={ArrowUpCircle}
          title="Upgrader Transactions"
          subtitle="Every upgrader game — bet, payout, and house P&L."
        />
      </PageHero>

      <div className="space-y-4">
        <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="inline-flex gap-1 rounded-lg bg-muted p-1">
            {OUTCOME_TABS.map((t) => (
              <Link
                key={t.value}
                href={`/transactions/upgrader?tab=${t.value}`}
                className={cn(
                  "shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  tab === t.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
              </Link>
            ))}
          </div>
        </div>
        <Suspense fallback={<Skeleton className="h-10 w-full" />}>
          <DataTableToolbar searchPlaceholder="Search by user ID, username, or game ID..." />
        </Suspense>
      </div>

      <div className="space-y-3">
        <SectionHeading icon={ArrowUpCircle} title="Upgrader plays" />
        <Suspense
          key={suspenseKey}
          fallback={
            <>
              <TableSkeleton rows={Math.min(perPage, 15)} columns={7} />
              <PaginationSkeleton />
            </>
          }
        >
          <UpgraderTxTableSection
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

async function UpgraderTxTableSection({
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
  const result = await getUpgraderTransactions({
    page,
    perPage,
    search,
    outcome: tab,
  });
  return (
    <>
      <FadeIn>
        <UpgraderTransactionsDataTable data={result.data} />
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
