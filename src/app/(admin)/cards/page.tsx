import { Suspense } from "react";
import {
  Layers,
  Library,
  Sparkles,
  Gem,
  Coins,
  Crown,
} from "lucide-react";
import { getCards, getCardsStats, getRarities, getSets } from "@/lib/queries/cards";
import { requirePageAccess } from "@/lib/dal";
import { CardsGrid } from "./cards-grid";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { PaginationSkeleton } from "@/components/loading-skeletons";
import { CreateCardButton } from "./create-card-button";
import { PriceFilter } from "./price-filter";
import { SetFilter } from "./set-filter";
import { PageHero, KpiTile } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

export const metadata = { title: "Cards" };

/**
 * Streaming server component for the cards grid + count summary +
 * pagination. The hero + KPI strip render immediately from `stats` /
 * `rarities` / `sets`; only the per-page slice waits on this query.
 */
async function CardsContent({
  page,
  perPage,
  search,
  rarity,
  setId,
  minPrice,
  maxPrice,
  sortBy,
  sortOrder,
}: {
  page: number;
  perPage: number;
  search?: string;
  rarity?: string;
  setId?: string;
  minPrice?: string;
  maxPrice?: string;
  sortBy?: string;
  sortOrder?: string;
}) {
  const result = await getCards({
    page,
    perPage,
    search,
    rarity,
    setId,
    minPrice,
    maxPrice,
    sortBy,
    sortOrder,
  });

  return (
    <>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Sparkles className="size-3.5" />
        <span>
          Showing{" "}
          <span className="font-medium text-foreground tabular-nums">
            {formatNumber(result.data.length)}
          </span>{" "}
          of{" "}
          <span className="font-medium text-foreground tabular-nums">
            {formatNumber(result.total)}
          </span>{" "}
          cards
        </span>
      </div>
      <FadeIn>
        <CardsGrid data={result.data} />
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

export default async function CardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/cards");
  const params = await searchParams;
  const page = Number(params.page) || 1;
  // Bumped from 20 → 40 so the denser 10-per-row grid fills 4 rows by default.
  const perPage = Number(params.perPage) || 40;

  // Hero/KPI/toolbar dependencies — small, fast queries, awaited up-front
  // so the static frame can render. The expensive paginated `getCards`
  // call lives inside the Suspense boundary below.
  const [rarities, sets, stats] = await Promise.all([
    getRarities(),
    getSets(),
    getCardsStats(),
  ]);

  // Pull out a couple of rarity counts for dedicated KPI tiles. We care
  // about the two that signal "quality" — anything with "rare" in the
  // name (but not "ultra"/"secret") and the top-tier bucket rolled up.
  // If the catalog doesn't have those rarities the tiles show 0.
  const rareCount = stats.byRarity
    .filter((r) => /rare/i.test(r.rarity) && !/ultra/i.test(r.rarity))
    .reduce((sum, r) => sum + r.count, 0);
  const ultraCount = stats.byRarity
    .filter((r) => /(ultra|secret|legendary)/i.test(r.rarity))
    .reduce((sum, r) => sum + r.count, 0);

  const suspenseKey = `${page}|${perPage}|${params.search ?? ""}|${params.rarity ?? ""}|${params.setId ?? ""}|${params.minPrice ?? ""}|${params.maxPrice ?? ""}|${params.sortBy ?? ""}|${params.sortOrder ?? ""}`;

  return (
    <div className="space-y-6">
      {/* ── HERO ───────────────────────────────────────────────────── */}
      <PageHero>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
              <Layers className="size-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-bold leading-tight">Cards</h1>
              <p className="text-sm text-muted-foreground">
                Browse and manage card assets across all sets.
              </p>
            </div>
          </div>
          <CreateCardButton sets={sets} />
        </div>
      </PageHero>

      {/* ── KPI STRIP ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        <KpiTile
          label="Total Cards"
          value={formatNumber(stats.total)}
          icon={Layers}
          accent="blue"
        />
        <KpiTile
          label="Sets"
          value={formatNumber(stats.totalSets)}
          icon={Library}
          accent="cyan"
        />
        <KpiTile
          label="Rare"
          value={formatNumber(rareCount)}
          icon={Gem}
          accent="purple"
        />
        <KpiTile
          label="Ultra / Secret"
          value={formatNumber(ultraCount)}
          icon={Crown}
          accent="amber"
        />
        <KpiTile
          label="Avg. Price"
          value={formatCurrency(stats.avgPriceUsd)}
          sub={
            stats.maxPriceUsd > 0
              ? `max ${formatCurrency(stats.maxPriceUsd)}`
              : undefined
          }
          icon={Coins}
          accent="emerald"
        />
      </div>

      {/* ── TOOLBAR + GRID ────────────────────────────────────────── */}
      <div className="space-y-4">
        <Suspense fallback={<Skeleton className="h-10 w-full" />}>
          <DataTableToolbar
            searchPlaceholder="Search by name..."
            filters={[
              {
                name: "Rarity",
                paramKey: "rarity",
                options: rarities
                  .filter((r): r is string => r != null)
                  .map((r) => ({ label: r, value: r })),
              },
            ]}
          >
            <SetFilter sets={sets} />
            <PriceFilter />
          </DataTableToolbar>
        </Suspense>

        <Suspense
          key={suspenseKey}
          fallback={
            <>
              <Skeleton className="h-4 w-48" />
              <div className="grid gap-3 grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10">
                {Array.from({ length: 40 }).map((_, i) => (
                  <Skeleton
                    key={i}
                    className="rounded-lg"
                    style={{ aspectRatio: "3/4" }}
                  />
                ))}
              </div>
              <PaginationSkeleton />
            </>
          }
        >
          <CardsContent
            page={page}
            perPage={perPage}
            search={params.search}
            rarity={params.rarity}
            setId={params.setId}
            minPrice={params.minPrice}
            maxPrice={params.maxPrice}
            sortBy={params.sortBy}
            sortOrder={params.sortOrder}
          />
        </Suspense>
      </div>
    </div>
  );
}
