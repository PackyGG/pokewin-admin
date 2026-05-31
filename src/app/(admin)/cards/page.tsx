import { Suspense } from "react";
import {
  Layers,
  Library,
  Sparkles,
  Gem,
  Coins,
  Crown,
} from "lucide-react";
import {
  getCards,
  getCardsStats,
  getRarities,
  getSets,
  getSetsForMoveDialog,
  getDistinctSeries,
} from "@/lib/queries/cards";
import { requirePageAccess } from "@/lib/dal";
import { CardsGrid } from "./cards-grid";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { PaginationSkeleton } from "@/components/loading-skeletons";
import { CreateCardButton } from "./create-card-button";
import { PriceFilter } from "./price-filter";
import { SetFilter } from "./set-filter";
import { CardsTabSwitch, type CardSetTab } from "./_components/cards-tab-switch";
import {
  PageHero,
  PageHeroIdentity,
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { safeQuery } from "@/lib/errors/safe-query";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

/**
 * Build the per-set tab list — Pokemon + OnePiece pinned to the front when
 * they exist, every other set sorted alphabetically after them. Slug for
 * the two well-known sets is the lowercase name ("pokemon" / "onepiece")
 * so URL links read nicely; every other set falls back to its UUID.
 *
 * Matching the well-known sets by name is intentional: the seed (see
 * `seedInitialSets` in /sets) upserts them by the exact strings "Pokemon"
 * and "OnePiece", so a case-insensitive name match is the source of
 * truth, not a separate enum on the row.
 */
function buildSetTabs(sets: { id: string; name: string }[]): CardSetTab[] {
  const pokemon = sets.find((s) => s.name.toLowerCase() === "pokemon");
  const onepiece = sets.find((s) => s.name.toLowerCase() === "onepiece");
  const pinnedIds = new Set(
    [pokemon?.id, onepiece?.id].filter((id): id is string => Boolean(id)),
  );

  const others = sets
    .filter((s) => !pinnedIds.has(s.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  const tabs: CardSetTab[] = [];
  if (pokemon) tabs.push({ id: pokemon.id, label: pokemon.name, slug: "pokemon" });
  if (onepiece)
    tabs.push({ id: onepiece.id, label: onepiece.name, slug: "onepiece" });
  for (const s of others) tabs.push({ id: s.id, label: s.name, slug: s.id });
  return tabs;
}

/**
 * Resolve the `?set=` URL param (slug like "pokemon"/"onepiece" OR a
 * raw UUID) to an actual setId from the tabs list. Returns `null` if
 * the param is missing OR doesn't match a known tab — the page treats
 * a stray/unknown value as "no tab active" rather than crashing.
 */
function resolveSetFromParam(
  raw: string | undefined,
  tabs: CardSetTab[],
): { setId: string; label: string } | null {
  if (!raw) return null;
  const tab = tabs.find((t) => t.slug === raw || t.id === raw);
  return tab ? { setId: tab.id, label: tab.label } : null;
}

export const metadata = { title: "Cards" };

/**
 * Streaming server component for the cards grid + count summary +
 * pagination. The hero + KPI strip render immediately from `stats` /
 * `rarities` / `sets`; only the per-page slice waits on this query.
 *
 * `getCards()` is wrapped in safeQuery so a Prisma column drift
 * (e.g. a newly-added schema field that hasn't reached the live DB)
 * degrades to an inline error tile instead of crashing the whole
 * `(admin)` route group via error.tsx. The hero/KPI strip above
 * already rendered before this Suspense resolved.
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
  setsForDialog,
  seriesOptions,
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
  setsForDialog: Awaited<ReturnType<typeof getSetsForMoveDialog>>;
  seriesOptions: string[];
}) {
  const { data: result, error } = await safeQuery(
    () =>
      getCards({
        page,
        perPage,
        search,
        rarity,
        setId,
        minPrice,
        maxPrice,
        sortBy,
        sortOrder,
      }),
    null,
    "cards.list",
  );

  if (error || !result) {
    return (
      <TileErrorFallback
        label="Card catalog"
        hint="The cards query failed — most likely a Prisma schema field that hasn't reached the live DB yet. Server logs hold the digest."
        size="panel"
      />
    );
  }

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
        <CardsGrid
          data={result.data}
          sets={setsForDialog}
          seriesOptions={seriesOptions}
        />
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
  //
  // `setsForDialog` and `seriesOptions` power the bulk-move dialog that
  // the cards grid opens from its selection toolbar. They're cheap enough
  // to fetch alongside the rest.
  //
  // `sets` is fetched up-front so the tab switch + the (still-existing)
  // SetFilter dropdown + the resolve-slug helper all share the same row
  // set without re-querying.
  //
  // Each fetch is wrapped in safeQuery so a single failing query (most
  // commonly a Prisma client/DB schema drift after a migration that
  // hasn't reached the live DB yet) degrades that section's UI to a
  // TileErrorFallback rather than crashing the whole page through the
  // `(admin)` error boundary. The page itself keeps rendering with
  // whatever subset of queries succeeded.
  const [raritiesRes, setsRes, setsForDialogRes, seriesOptionsRes] =
    await Promise.all([
      safeQuery(() => getRarities(), [] as (string | null)[], "cards.rarities"),
      safeQuery(
        () => getSets(),
        [] as Awaited<ReturnType<typeof getSets>>,
        "cards.sets",
      ),
      safeQuery(
        () => getSetsForMoveDialog(),
        [] as Awaited<ReturnType<typeof getSetsForMoveDialog>>,
        "cards.setsForDialog",
      ),
      safeQuery(() => getDistinctSeries(), [] as string[], "cards.series"),
    ]);
  const rarities = raritiesRes.data;
  const sets = setsRes.data;
  const setsForDialog = setsForDialogRes.data;
  const seriesOptions = seriesOptionsRes.data;

  // Build the per-set tab pills (Pokemon + OnePiece first, rest A→Z) and
  // resolve `?set=<slug|uuid>` to the actual set we'll narrow on. When
  // the param is absent or unknown, `activeSet` is null → "All Sets" tab
  // active, every aggregate / list query runs unscoped.
  const tabs = buildSetTabs(sets);
  const activeSet = resolveSetFromParam(params.set, tabs);

  // Stats are now tab-scoped — when a tab is active the KPI strip
  // (total / rare / ultra / avg price) reflects ONLY that set, matching
  // the count under the toolbar. The dedicated cache key on
  // `getCardsStats` keeps the catalog-wide and per-set variants in
  // separate cache slots.
  //
  // Wrapped in safeQuery so a failing aggregate doesn't take down the
  // whole page — the KPI strip simply degrades to a single
  // TileErrorFallback row while the catalog grid below keeps rendering.
  const { data: stats } = await safeQuery(
    () => getCardsStats(activeSet?.setId),
    null,
    "cards.stats",
  );

  // Pull out a couple of rarity counts for dedicated KPI tiles. We care
  // about the two that signal "quality" — anything with "rare" in the
  // name (but not "ultra"/"secret") and the top-tier bucket rolled up.
  // If the catalog doesn't have those rarities the tiles show 0. When
  // `stats` is null (safeQuery returned the fallback) both counts are
  // zeroed so the downstream tiles never read off undefined.
  const rareCount = stats
    ? stats.byRarity
        .filter((r) => /rare/i.test(r.rarity) && !/ultra/i.test(r.rarity))
        .reduce((sum, r) => sum + r.count, 0)
    : 0;
  const ultraCount = stats
    ? stats.byRarity
        .filter((r) => /(ultra|secret|legendary)/i.test(r.rarity))
        .reduce((sum, r) => sum + r.count, 0)
    : 0;

  // When a tab is active, the tab's set wins over the toolbar's
  // `?setId=` dropdown — the dropdown is hidden inside a tab view
  // anyway (the tab already narrows). Outside a tab, `?setId=` still
  // works for the "Unassigned" sentinel + ad-hoc filtering.
  const effectiveSetId = activeSet?.setId ?? params.setId;

  const suspenseKey = `${activeSet?.setId ?? ""}|${page}|${perPage}|${params.search ?? ""}|${params.rarity ?? ""}|${params.setId ?? ""}|${params.minPrice ?? ""}|${params.maxPrice ?? ""}|${params.sortBy ?? ""}|${params.sortOrder ?? ""}`;

  return (
    <div className="space-y-6">
      {/* ── HERO ───────────────────────────────────────────────────── */}
      <PageHero>
        <PageHeroIdentity
          icon={Layers}
          title="Cards"
          subtitle="Browse and manage card assets across all sets."
          action={
            <CreateCardButton
              sets={sets}
              defaultSetId={activeSet?.setId ?? ""}
            />
          }
        />
      </PageHero>

      {/* ── KPI STRIP ───────────────────────────────────────────────
           When the stats aggregate query failed (safeQuery returned
           null), the entire strip collapses to a single
           TileErrorFallback row instead of zero-ing out every tile.
           The toolbar + grid below are unaffected. */}
      {stats ? (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
          <KpiTile
            label={activeSet ? `Cards in ${activeSet.label}` : "Total Cards"}
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
      ) : (
        <TileErrorFallback
          label="Catalog stats"
          hint="The aggregate stats query failed. The cards grid below is unaffected — refresh to retry."
        />
      )}

      {/* ── TAB SWITCH ────────────────────────────────────────────── */}
      {tabs.length > 0 && (
        <div className="flex">
          <CardsTabSwitch tabs={tabs} />
        </div>
      )}

      {/* ── TOOLBAR + GRID ────────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeading
          icon={Layers}
          title={activeSet ? activeSet.label : "Catalog"}
        />
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
            {/* Hide the manual set-dropdown when a tab is active — the
                tab already narrows the catalog, the second narrowing
                would just be redundant UI. Outside a tab, keep the
                dropdown for the "Unassigned" sentinel and ad-hoc
                set-by-id filtering. */}
            {!activeSet && <SetFilter sets={sets} />}
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
            setId={effectiveSetId}
            minPrice={params.minPrice}
            maxPrice={params.maxPrice}
            sortBy={params.sortBy}
            sortOrder={params.sortOrder}
            setsForDialog={setsForDialog}
            seriesOptions={seriesOptions}
          />
        </Suspense>
      </div>
    </div>
  );
}
