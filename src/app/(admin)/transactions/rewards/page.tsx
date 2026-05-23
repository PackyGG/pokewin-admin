import { Suspense } from "react";
import Link from "next/link";
import { Gift } from "lucide-react";
import { getTransactions } from "@/lib/queries/transactions";
import { requirePageAccess } from "@/lib/dal";
import { TransactionsDataTable } from "../data-table";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

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
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {STATUS_TABS.map((t) => (
            <Link
              key={t.value}
              href={`/transactions/rewards?tab=${t.value}`}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                tab === t.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t.label}
            </Link>
          ))}
        </div>
        <Suspense fallback={<Skeleton className="h-10 w-full" />}>
          <DataTableToolbar
            searchPlaceholder="Search by user ID, username, or transaction ID..."
          />
        </Suspense>
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
  const result = await getTransactions({
    page,
    perPage,
    search,
    types: TYPES,
    status: tab === "all" ? undefined : tab,
  });
  return (
    <>
      <FadeIn>
        <TransactionsDataTable data={result.data} />
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
