import { Suspense } from "react";
import { CheckCircle2, Clock, Users, HandCoins, Wallet, Ticket } from "lucide-react";
import { getPromoCodes, getPromoCodesListStats } from "@/lib/queries/promo-codes";
import { getPromoCodesMoneyStats } from "@/lib/queries/promo-codes-stats";
import { safeQuery } from "@/lib/errors/safe-query";
import { formatCurrency } from "@/lib/utils/format";
import { PromoCodesDataTable } from "../promo-codes/data-table";
import { PromoCodesSelectionProvider } from "../promo-codes/promo-codes-selection-context";
import { PromoCodesQuickSelect } from "../promo-codes/promo-codes-quick-select";
import { CreatePromoCodeButton } from "../promo-codes/create-button";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TableSkeleton,
  PaginationSkeleton,
} from "@/components/loading-skeletons";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { TileErrorFallback } from "@/components/tile-error-fallback";

/**
 * Promo Codes tab of the merged /rewards page (was the standalone
 * /promo-codes LIST page). The /promo-codes/[id] detail route stays and its
 * back-link points to /rewards?tab=promo-codes.
 *
 * Only rendered/awaited when the top-level tab is `promo-codes`
 * (active-tab-only). Its own filter params (`?status=`, `?region=`, `?page=`)
 * don't collide with the top-level `?tab=`.
 */
export async function PromoCodesTab({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  // Stats stay stable across the region / status filter — admins get a fixed
  // read-out of the promo-code pool while they refine the table on screen.
  // Both stats reads are wrapped in safeQuery so a slow / failing aggregate
  // degrades its own tiles instead of crashing the tab; the table still
  // renders behind its keyed <Suspense>.
  const [{ data: stats }, { data: money }] = await Promise.all([
    safeQuery(
      () => getPromoCodesListStats(),
      null as Awaited<ReturnType<typeof getPromoCodesListStats>> | null,
      "promoCodes.listStats",
    ),
    safeQuery(
      () => getPromoCodesMoneyStats(),
      null as Awaited<ReturnType<typeof getPromoCodesMoneyStats>> | null,
      "promoCodes.moneyStats",
    ),
  ]);

  return (
    <div className="space-y-6">
      {stats ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiTile
            label="Total Codes"
            value={String(stats.totalCodes)}
            icon={Ticket}
            accent="blue"
          />
          <KpiTile
            label="Active"
            value={String(stats.activeCount)}
            icon={CheckCircle2}
            accent="emerald"
          />
          <KpiTile
            label="Expired"
            value={String(stats.expiredCount)}
            icon={Clock}
            accent="rose"
          />
          <KpiTile
            label="Redemptions"
            value={String(stats.totalRedemptions)}
            icon={Users}
            accent="purple"
          />
        </div>
      ) : (
        <TileErrorFallback
          label="Code stats"
          hint="The aggregate stats query failed. The code list below is unaffected — refresh to retry."
        />
      )}

      {/* Lifetime promo-code money strip. House-POV: promo value handed to
          users is a house COST → rose headline. Both degrade to "—" via
          safeQuery. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <KpiTile
          label="Given out / claimed"
          value={money ? formatCurrency(money.claimedGivenOut) : "—"}
          sub="Realized house cost · all codes incl. deleted"
          icon={HandCoins}
          accent="rose"
        />
        <KpiTile
          label="Allocated / offered"
          value={money ? formatCurrency(money.allocatedOffered) : "—"}
          sub="Budget put up · current codes only"
          icon={Wallet}
          accent="blue"
        />
      </div>

      <div className="space-y-3">
        <SectionHeading
          icon={Ticket}
          title="All Codes"
          action={<CreatePromoCodeButton />}
        />
        {/* Selection provider wraps BOTH the toolbar (outside the keyed
            Suspense, so the search input stays mounted/focused while the
            table streams) AND the table (inside it). */}
        <PromoCodesSelectionProvider>
          <div className="space-y-4">
            <Suspense fallback={<Skeleton className="h-10 w-full" />}>
              <DataTableToolbar
                searchPlaceholder="Search promo codes..."
                filters={[
                  {
                    name: "Status",
                    paramKey: "status",
                    options: [
                      { label: "Active", value: "active" },
                      { label: "Expired", value: "expired" },
                    ],
                  },
                ]}
              >
                <PromoCodesQuickSelect />
              </DataTableToolbar>
            </Suspense>
            {/* Keyed on the table inputs so a filter / page change re-shows
                the table skeleton instead of blocking on the previous
                render. */}
            <Suspense
              key={`${params.status ?? ""}|${params.region ?? ""}|${params.page ?? "1"}|${params.perPage ?? "20"}`}
              fallback={
                <>
                  <TableSkeleton rows={12} columns={7} />
                  <PaginationSkeleton />
                </>
              }
            >
              <PromoCodesListAsync params={params} />
            </Suspense>
          </div>
        </PromoCodesSelectionProvider>
      </div>
    </div>
  );
}

async function PromoCodesListAsync({
  params,
}: {
  params: Record<string, string | undefined>;
}) {
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const result = await getPromoCodes({
    page,
    perPage,
    region: params.region,
    status: params.status,
  });

  return (
    <>
      <FadeIn>
        <PromoCodesDataTable data={result.data} />
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
