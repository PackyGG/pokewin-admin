import { Suspense } from "react";
import { Library, Layers, FolderTree } from "lucide-react";
import { getSetsList, getSeriesList, getSetsStats } from "@/lib/queries/sets";
import { requirePageAccess } from "@/lib/dal";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { FilterBarSkeleton } from "@/components/entity-surface";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { loadPrimary } from "@/lib/entity-surface/loader";
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
  // `getSetsList` runs through `loadPrimary` (safeQuery + timeout) so a Prisma
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
        hint="The sets query failed — most likely a Prisma schema field that hasn't reached the live DB yet. Server logs hold the digest."
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

export default async function SetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePageAccess("/sets");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  const perPage = Number(params.perPage) || 20;

  const [series, stats] = await Promise.all([getSeriesList(), getSetsStats()]);

  const suspenseKey = `${page}|${perPage}|${params.search ?? ""}|${params.series ?? ""}|${params.sortBy ?? ""}|${params.sortOrder ?? ""}`;

  // The bulk-backfill button is admin-only — the capability gate on the
  // server action ultimately enforces this, but we also hide the affordance
  // for non-admins so the UI matches the permission.
  const isAdmin = session.role === "admin";

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Library}
          title="Sets"
          subtitle="Group cards into sets and series (Pokémon, One Piece, …)."
          action={
            <div className="flex items-center gap-2">
              {isAdmin && <SeedInitialSetsButton />}
              {isAdmin && <ForceAbsorbIntoPokemonButton />}
              <SetFormDialog mode="create" />
            </div>
          }
        />
      </PageHero>

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
