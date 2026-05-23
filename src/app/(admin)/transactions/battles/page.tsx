import { Suspense } from "react";
import Link from "next/link";
import { Swords } from "lucide-react";
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
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";

export const metadata = { title: "Battle Transactions" };

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
];

const TYPES = [
  "battle_bet",
  "battle_sponsorship",
  "battle_refund",
  "battle_excess_to_voucher",
];

export default async function BattleTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/transactions/battles");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const tab = params.tab || "all";

  // Suspense key — re-mount the table boundary on input change.
  const suspenseKey = `${tab}|${page}|${perPage}|${params.search ?? ""}`;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Swords}
          title="Battle Transactions"
          subtitle="Battle bets, sponsorships, and refunds — filtered across all modes."
        />
      </PageHero>

      <div className="space-y-4">
        <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="inline-flex gap-1 rounded-lg bg-muted p-1">
            {STATUS_TABS.map((t) => (
              <Link
                key={t.value}
                href={`/transactions/battles?tab=${t.value}`}
                className={cn(
                  "shrink-0 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  tab === t.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {t.label}
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
        <SectionHeading icon={Swords} title="Battle movements" />
        {/* getTransactions for battle types still hits the big
            ledger_transactions scan + game_sessions join. Stream the
            table so the page chrome flushes immediately. */}
        <Suspense
          key={suspenseKey}
          fallback={
            <>
              <TableSkeleton rows={Math.min(perPage, 15)} columns={6} />
              <PaginationSkeleton />
            </>
          }
        >
          <BattleTxTableSection
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

async function BattleTxTableSection({
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
