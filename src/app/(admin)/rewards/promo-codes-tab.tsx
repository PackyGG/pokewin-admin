import { Suspense } from "react";
import { unstable_cache } from "next/cache";
import {
  CheckCircle2,
  Clock,
  Users,
  HandCoins,
  Wallet,
  Ticket,
  AlertTriangle,
} from "lucide-react";
import { getPromoCodes, getPromoCodesListStats } from "@/lib/queries/promo-codes";
import { getPromoCodesMoneyStats } from "@/lib/queries/promo-codes-stats";
import { readDbEnv } from "@/lib/db-env";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
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

// Prod-only, 60s cross-request cache for the two hero-strip stats reads.
//
// The underlying queries are already `unstable_cache`d in their own modules,
// but WITHOUT a prod-only guard: `unstable_cache` runs its callback outside the
// request's dynamic scope, so a dev-toggled admin's `admin_db_env` cookie read
// falls back to "prod" inside the callback and they'd be served PROD numbers.
// This call-site layer caches ONLY on prod (keyed on the resolved env so the
// two envs never share an entry) and bypasses to the live read on a dev-toggled
// admin — the same prod-only pattern as `users-detail-cache.ts`. Tags mirror
// the underlying queries so a promo mutation's `revalidateTag` busts this layer
// too. 60s TTL keeps the strip near-live.
const cachedPromoStripStats = unstable_cache(
  async () => {
    const [listStats, moneyStats] = await Promise.all([
      getPromoCodesListStats(),
      getPromoCodesMoneyStats(),
    ]);
    return { listStats, moneyStats };
  },
  ["promo-codes-tab-strip-stats-v1"],
  {
    revalidate: 60,
    tags: ["promo-codes-list-stats", "promo-codes-money-stats"],
  },
);

async function getPromoStripStats(): Promise<{
  listStats: Awaited<ReturnType<typeof getPromoCodesListStats>>;
  moneyStats: Awaited<ReturnType<typeof getPromoCodesMoneyStats>>;
}> {
  const env = await readDbEnv();
  if (env !== "prod") {
    const [listStats, moneyStats] = await Promise.all([
      getPromoCodesListStats(),
      getPromoCodesMoneyStats(),
    ]);
    return { listStats, moneyStats };
  }
  return cachedPromoStripStats();
}

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
  // Both stats reads share ONE prod-only 60s cache entry (getPromoStripStats)
  // and are wrapped in safeQuery so a slow / failing aggregate degrades its own
  // tiles to "—" instead of crashing the tab; the table still renders behind
  // its keyed <Suspense>.
  const { data: strip } = await safeQuery(
    () => getPromoStripStats(),
    null as Awaited<ReturnType<typeof getPromoStripStats>> | null,
    "promoCodes.stripStats",
  );
  const stats = strip?.listStats ?? null;
  const money = strip?.moneyStats ?? null;

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

  // safeQuery so a slow / failing list read degrades to an inline band +
  // empty table instead of throwing up the /rewards route boundary (which
  // blanks the WHOLE hub). Fallback is an empty page of codes.
  const { data: result, error } = await safeQuery(
    () =>
      getPromoCodes({
        page,
        perPage,
        region: params.region,
        status: params.status,
      }),
    {
      data: [],
      total: 0,
      page,
      perPage,
      totalPages: 1,
    } as Awaited<ReturnType<typeof getPromoCodes>>,
    "promoCodes.list",
    REWARD_QUERY_TIMEOUT_MS,
  );
  const failed = error !== null;

  return (
    <>
      {failed && (
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
            Couldn&apos;t load promo codes — the query timed out or failed. This
            is a{" "}
            <span className="font-medium">request error, not zero results</span>
            . Refresh to retry.
          </p>
        </div>
      )}
      <FadeIn>
        <PromoCodesDataTable data={result.data} />
      </FadeIn>
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
        degraded={failed}
      />
    </>
  );
}
