import { Suspense } from "react";
import Link from "next/link";
import { Swords } from "lucide-react";
import { getBattles, type BattleSortMode } from "@/lib/queries/battles";
import { requirePageAccess } from "@/lib/dal";
import { BattlesDataTable } from "./data-table";
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

export const metadata = { title: "Battles" };

const STATUS_TABS = [
  { value: "all", label: "All" },
  { value: "waiting", label: "Waiting" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

// Whitelist of accepted `sortBy` values to avoid forwarding random URL
// junk into the query layer (where it would fall through to "recent"
// anyway, but better to reject explicitly at the boundary).
const SORT_MODES: BattleSortMode[] = ["recent", "bet", "hit"];

export default async function BattlesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/battles");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const tab = params.tab || "all";

  const rawSort = params.sortBy;
  const sortBy: BattleSortMode = (
    rawSort && (SORT_MODES as string[]).includes(rawSort) ? rawSort : "recent"
  ) as BattleSortMode;
  const since = params.since === "24h" ? "24h" : undefined;

  // Suspense key — flips when any query input changes so the table
  // skeleton re-shows on in-segment navigation (tab / mode / sort /
  // period / page) instead of clearing the whole route. The hero,
  // status tabs, and toolbar stay mounted across the refetch; only the
  // table region streams behind the boundary. Mirrors the streaming
  // pattern the sibling /transactions sub-pages already use.
  const suspenseKey = `${tab}|${page}|${perPage}|${sortBy}|${params.mode ?? ""}|${params.search ?? ""}|${since ?? ""}`;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Swords}
          title="Battles"
          subtitle="Case battles across all modes — track status, teams, and outcomes."
        />
      </PageHero>

      <div className="space-y-4">
        <div className="flex gap-1 rounded-lg bg-muted p-1">
          {STATUS_TABS.map((t) => (
            <Link
              key={t.value}
              href={`/battles?tab=${t.value}`}
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
            searchPlaceholder="Search by battle ID or username..."
            filters={[
              {
                name: "Mode",
                paramKey: "mode",
                options: [
                  { label: "Normal", value: "normal" },
                  { label: "Jackpot", value: "jackpot" },
                  { label: "Group", value: "group" },
                  { label: "HP Rush", value: "hp_rush" },
                  { label: "Lowest", value: "lowest" },
                ],
              },
              // Sort dropdown — admins want to find the big battles
              // quickly. "Bet" = highest single buy-in; "Hit" = biggest
              // total payout (only on completed battles).
              {
                name: "Sort",
                paramKey: "sortBy",
                allLabel: "Recent",
                options: [
                  { label: "Recent", value: "recent" },
                  { label: "Highest Bet", value: "bet" },
                  { label: "Biggest Hit", value: "hit" },
                ],
              },
              // Time window — composes with Sort. Pairing Sort=Hit
              // with Since=24h answers "biggest hit today" in two
              // clicks.
              {
                name: "Period",
                paramKey: "since",
                allLabel: "All time",
                options: [
                  { label: "All time", value: "all" },
                  { label: "Last 24h", value: "24h" },
                ],
              },
            ]}
          />
        </Suspense>
        {/* getBattles joins battles → teams → players → cards to compute
            per-row bet / house-edge — heavy enough to block the route
            render on its own. Streamed inside a keyed Suspense so the
            hero + tabs + toolbar flush immediately and survive filter
            changes; the table region shows a row-matched skeleton while
            the re-query is in flight rather than blanking the page. */}
        <Suspense
          key={suspenseKey}
          fallback={
            <>
              <TableSkeleton rows={Math.min(perPage, 12)} columns={7} />
              <PaginationSkeleton />
            </>
          }
        >
          <BattlesTableSection
            page={page}
            perPage={perPage}
            status={tab === "all" ? undefined : tab}
            mode={params.mode}
            search={params.search}
            sortBy={sortBy}
            since={since}
          />
        </Suspense>
      </div>
    </div>
  );
}

async function BattlesTableSection({
  page,
  perPage,
  status,
  mode,
  search,
  sortBy,
  since,
}: {
  page: number;
  perPage: number;
  status: string | undefined;
  mode: string | undefined;
  search: string | undefined;
  sortBy: BattleSortMode;
  since: "24h" | undefined;
}) {
  const result = await getBattles({
    page,
    perPage,
    status,
    mode,
    search,
    sortBy,
    since,
  });

  return (
    <>
      <FadeIn>
        <BattlesDataTable data={result.data} />
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
