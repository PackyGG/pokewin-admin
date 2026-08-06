import Link from "next/link";
import { Suspense } from "react";
import { Ticket, Coins, CheckCircle2, Clock } from "lucide-react";
import {
  getVouchers,
  getVoucherCreators,
  getVouchersListStats,
} from "@/lib/queries/vouchers";
import { requirePageAccess } from "@/lib/dal";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TableSkeleton,
  PaginationSkeleton,
  KpiStripSkeleton,
} from "@/components/loading-skeletons";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { ValueRangeFilter } from "./value-range-filter";
import { VouchersTable } from "./vouchers-table";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { LinkPending } from "@/components/ux";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { safeQuery, safeQueryOrNull } from "@/lib/errors/safe-query";

export const metadata = { title: "Vouchers" };

export default async function VouchersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/vouchers");
  const params = await searchParams;
  const tab = params.tab || "unclaimed";

  // Stats + creator filter options are tab-independent, so they never re-fetch
  // on a tab/filter flip — but neither may block the hero either. Both moved
  // into the child that consumes them, behind their own <Suspense>:
  //   • `getVouchersListStats()` is a `COUNT(*) FILTER` / `SUM` over the WHOLE
  //     vouchers table with no predicate — a full scan on every cache miss —
  //     and it only feeds the KPI strip.
  //   • `getVoucherCreators()` only feeds the toolbar's Created-By filter, so
  //     it now runs inside the toolbar's already-existing <Suspense>.
  // Each stays safeQuery-wrapped so a failing query degrades only its own
  // section — the KPI strip collapses to a TileErrorFallback and the
  // Created-By filter falls back to the System-only option — instead of
  // crashing the whole page to the route error boundary (mirrors /cards).
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <Suspense fallback={<KpiStripSkeleton count={4} />}>
        <VoucherStatsAsync />
      </Suspense>

      <div className="space-y-3">
        <SectionHeading icon={Ticket} title="Voucher List" />

        <div className="flex gap-1 rounded-lg bg-muted p-1 w-fit">
          {[
            { value: "unclaimed", label: "Unclaimed" },
            { value: "claimed", label: "Claimed" },
          ].map((t) => (
            <Link
              key={t.value}
              href={`/vouchers?tab=${t.value}`}
              // Don't eager-prefetch the other tab's list read on hover — the
              // Claimed list query (plus its FTD-balance enrichment) should
              // only run when the tab is actually clicked (Active-Timeframe-
              // Only / active-tab-only, per CLAUDE.md).
              prefetch={false}
              className={cn(
                "inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                tab === t.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              <LinkPending size={13} />
            </Link>
          ))}
        </div>

        <div className="space-y-4">
          <Suspense fallback={<Skeleton className="h-10 w-full" />}>
            <VouchersToolbarAsync />
          </Suspense>

          {/* Keyed on every query input so a tab/search/filter/page change
              re-shows the table skeleton instead of blocking the whole page
              on the previous render — matches the rain / rewards pattern. */}
          <Suspense
            key={`${tab}|${params.page ?? "1"}|${params.perPage ?? "20"}|${params.search ?? ""}|${params.createdBy ?? ""}|${params.minValue ?? ""}|${params.maxValue ?? ""}`}
            fallback={
              <>
                <TableSkeleton rows={12} columns={6} />
                <PaginationSkeleton />
              </>
            }
          >
            <VouchersListAsync params={params} tab={tab} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

/**
 * KPI strip. Stats are global + tab-independent: both unclaimed and claimed
 * counts/totals always render. Vouchers are unspent credits the house owes
 * users, so the unclaimed value is the active liability and reads rose per
 * CLAUDE.md house-POV.
 */
async function VoucherStatsAsync() {
  const { data: stats } = await safeQuery(
    () => getVouchersListStats(),
    null,
    "vouchers.stats",
  );

  if (!stats) {
    return (
      <TileErrorFallback
        label="Voucher stats"
        hint="The aggregate stats query failed. The voucher list below is unaffected — refresh to retry."
      />
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <KpiTile
        label="Unclaimed Total"
        value={String(stats.unclaimedCount)}
        icon={Clock}
        accent="amber"
      />
      <KpiTile
        label="Unclaimed Value"
        value={formatCurrency(stats.unclaimedTotalValue)}
        icon={Coins}
        accent="rose"
      />
      <KpiTile
        label="Claimed Total"
        value={String(stats.claimedCount)}
        icon={CheckCircle2}
        accent="purple"
      />
      <KpiTile
        label="Claimed Value"
        value={formatCurrency(stats.claimedTotalValue)}
        icon={Ticket}
        accent="blue"
      />
    </div>
  );
}

/** Toolbar — the Created-By options are the only read it needs. */
async function VouchersToolbarAsync() {
  const { data: creators } = await safeQuery(
    () => getVoucherCreators(),
    [] as Awaited<ReturnType<typeof getVoucherCreators>>,
    "vouchers.creators",
  );

  const createdByOptions = [
    { label: "System", value: "system" },
    ...creators.map((c) => ({ label: c.username, value: c.id })),
  ];

  return (
    <DataTableToolbar
      searchPlaceholder="Search by username or email..."
      filters={[
        {
          name: "Created By",
          paramKey: "createdBy",
          options: createdByOptions,
        },
      ]}
    >
      <ValueRangeFilter />
    </DataTableToolbar>
  );
}

async function VouchersListAsync({
  params,
  tab,
}: {
  params: Record<string, string | undefined>;
  tab: string;
}) {
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;
  const claimed = tab === "claimed";

  // safeQuery-wrapped so a slow/failed list read degrades to a band instead
  // of tripping the route error boundary and white-screening the whole page
  // (the stats + creators reads above are already safeQuery-wrapped;
  // getVouchers itself carries a timeout, see queries/vouchers.ts).
  const { data: result } = await safeQueryOrNull(
    () =>
      getVouchers({
        page,
        perPage,
        claimed,
        search: params.search,
        minValue: params.minValue ? Number(params.minValue) : undefined,
        maxValue: params.maxValue ? Number(params.maxValue) : undefined,
        createdBy: params.createdBy,
      }),
    "vouchers.list",
  );

  if (!result) {
    return (
      <TileErrorFallback
        label="Voucher list"
        hint="The voucher list failed to load or timed out. Refresh to retry — the stats above are unaffected."
      />
    );
  }

  return (
    <>
      <FadeIn>
        <VouchersTable data={result.data} claimed={claimed} />
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
