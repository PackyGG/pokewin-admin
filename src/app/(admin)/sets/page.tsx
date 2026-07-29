import { Suspense } from "react";
import { Library, Layers, FolderTree } from "lucide-react";
import { getSetsList, getSeriesList, getSetsStats } from "@/lib/queries/sets";
import { requirePageAccess } from "@/lib/dal";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { FilterBarSkeleton } from "@/components/entity-surface";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { loadPrimary } from "@/lib/entity-surface/loader";
import { safeQuery } from "@/lib/errors/safe-query";
import { SetsContent } from "./sets-content";
import { SetsFilterBar } from "./sets-filter-bar";
import { SetsTableSkeleton } from "./_skeletons";
import { SetFormDialog } from "./set-form-dialog";
import { SeedInitialSetsButton } from "./seed-initial-sets-button";
import { ForceAbsorbIntoPokemonButton } from "./force-absorb-into-pokemon-button";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
} from "@/components/modern-panels";
import { KpiStripSkeleton } from "@/components/loading-skeletons";
import { FadeIn } from "@/components/fade-in";
import { formatNumber } from "@/lib/utils/format";

export const metadata = { title: "Sets" };

async function SetsListContent({
  page,
  perPage,
  search,
  series,
  sortBy,
  sortOrder,
  isAdmin,
}: {
  page: number;
  perPage: number;
  search?: string;
  series?: string;
  sortBy?: string;
  sortOrder?: string;
  isAdmin: boolean;
}) {
  // `getSetsList` runs through `loadPrimary` (safeQuery + timeout) so a schema
  // column drift or a pathological scan degrades to an inline error tile
  // instead of crashing the whole `(admin)` route group via error.tsx — the
  // same resilience /cards already has on its list call-site.
  const { data: result, error } = await loadPrimary(
    () => getSetsList({ page, perPage, search, series, sortBy, sortOrder }),
    null,
    "sets.list",
  );

  if (error || !result) {
    return (
      <TileErrorFallback
        label="Sets list"
        hint="The sets query failed — most likely a schema field that hasn't reached the live DB yet. Server logs hold the digest."
        size="panel"
      />
    );
  }

  return (
    <>
      <SetsContent data={result.data} isAdmin={isAdmin} />
      <DataTablePagination
        page={result.page}
        totalPages={result.totalPages}
        total={result.total}
        perPage={result.perPage}
      />
    </>
  );
}

/**
 * The KPI strip (catalog totals) streams behind its own <Suspense> so the
 * `getSetsStats` aggregate never blocks first paint — the PageHero shell paints
 * instantly and this fills in behind <KpiStripSkeleton>. safeQuery-wrapped so a
 * failing aggregate degrades to a TileErrorFallback for this section alone
 * instead of crashing the page (mirrors /cards).
 */
async function SetsKpiStrip() {
  const { data: stats } = await safeQuery(
    () => getSetsStats(),
    null,
    "sets.stats",
  );

  // When the stats aggregate query failed (safeQuery returned null) the strip
  // collapses to a single TileErrorFallback row instead of crashing the page;
  // the filter bar + list below are unaffected. (Mirrors /cards.)
  if (!stats) {
    return (
      <TileErrorFallback
        label="Catalog stats"
        hint="The aggregate stats query failed. The sets list below is unaffected — refresh to retry."
      />
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
      <KpiTile
        label="Total Sets"
        value={formatNumber(stats.total)}
        icon={Library}
        accent="blue"
      />
      <KpiTile
        label="Series"
        value={formatNumber(stats.totalSeries)}
        icon={FolderTree}
        accent="cyan"
      />
      <KpiTile
        label="Total Cards"
        value={formatNumber(stats.totalCards)}
        icon={Layers}
        accent="purple"
      />
    </div>
  );
}

export default async function SetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePageAccess("/sets");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  // Only the filter-bar series options are resolved in the page body — a small,
  // safeQuery-wrapped read. The heavy KPI aggregate (`getSetsStats`) streams in
  // its own <Suspense> child below so it never blocks first paint, and the list
  // streams in its own boundary. (Falls back to empty series options on failure
  // so the filter bar still renders.)
  const { data: series } = await safeQuery(
    () => getSeriesList(),
    [] as string[],
    "sets.series",
  );

  const suspenseKey = `${page}|${perPage}|${params.search ?? ""}|${params.series ?? ""}|${params.sortBy ?? ""}|${params.sortOrder ?? ""}`;

  // The bulk-backfill button is admin-only — the capability gate on the
  // server action ultimately enforces this, but we also hide the affordance
  // for non-admins so the UI matches the permission.
  const isAdmin = session.role === "admin";

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          action={
            <div className="flex items-center gap-2">
              {isAdmin && <SeedInitialSetsButton />}
              {isAdmin && <ForceAbsorbIntoPokemonButton />}
              <SetFormDialog mode="create" />
            </div>
          }
        />
      </PageHero>

      {/* KPI strip streams behind its own boundary so the heavy stats
          aggregate never blocks first paint. */}
      <Suspense fallback={<KpiStripSkeleton count={3} />}>
        <SetsKpiStrip />
      </Suspense>

      <div className="space-y-3">
        <SectionHeading icon={Library} title="All Sets" />
        <FadeIn className="space-y-4">
          <Suspense fallback={<FilterBarSkeleton filters={1} withTrailing={false} />}>
            <SetsFilterBar
              seriesOptions={series
                .filter((s): s is string => s != null)
                .map((s) => ({ label: s, value: s }))}
            />
          </Suspense>

          <Suspense
            key={suspenseKey}
            fallback={<SetsTableSkeleton />}
          >
            <SetsListContent
              page={page}
              perPage={perPage}
              search={params.search}
              series={params.series}
              sortBy={params.sortBy}
              sortOrder={params.sortOrder}
              isAdmin={isAdmin}
            />
          </Suspense>
        </FadeIn>
      </div>
    </div>
  );
}
