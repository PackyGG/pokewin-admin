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
  CARD_SORT_FIELDS,
} from "@/lib/queries/cards";
import { requirePageAccess, sessionIsAdmin } from "@/lib/dal";
import { CardsExplorer, type CardsFilter } from "./cards-explorer";
import { CardsFilterBar } from "./cards-filter-bar";
import {
  UNASSIGNED_TAB_SLUG,
  type CardSetTab,
} from "./_components/cards-tab-switch";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { CreateCardButton } from "./create-card-button";
import {
  PageHero,
  PageHeroIdentity,
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import {
  EntityTableSkeleton,
  EntityGridSkeleton,
  FilterBarSkeleton,
  EntityPaginationSkeleton,
} from "@/components/entity-surface";
import { KpiStripSkeleton } from "@/components/loading-skeletons";
import { resolveEntityView } from "@/components/entity-surface/view";
import { safeQuery } from "@/lib/errors/safe-query";
import { loadPrimary, parseListParams } from "@/lib/entity-surface/loader";
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

type ActiveSet =
  | { kind: "set"; setId: string; label: string }
  | { kind: "unassigned"; label: string };

/**
 * Resolve the `?set=` URL param (slug like "pokemon"/"onepiece", the
 * "unassigned" backlog sentinel, OR a raw UUID) to an active scope.
 *
 * Falls back to the Pokemon tab when the param is missing or doesn't match a
 * known tab. If neither Pokemon nor any other tab exists (empty catalog)
 * returns `null` so the page handles the no-sets case cleanly.
 */
function resolveSetFromParam(
  raw: string | undefined,
  tabs: CardSetTab[],
): ActiveSet | null {
  if (raw === UNASSIGNED_TAB_SLUG) {
    return { kind: "unassigned", label: "Unassigned" };
  }
  if (tabs.length === 0) return null;
  if (raw) {
    const tab = tabs.find((t) => t.slug === raw || t.id === raw);
    if (tab) return { kind: "set", setId: tab.id, label: tab.label };
  }
  // Default to Pokemon when present; otherwise the first tab in the list.
  const fallback = tabs.find((t) => t.slug === "pokemon") ?? tabs[0];
  return { kind: "set", setId: fallback.id, label: fallback.label };
}

export const metadata = { title: "Cards" };

/**
 * Streaming server component for the active view (table or gallery) + count
 * summary + pagination. The hero + KPI strip + filter bar render immediately
 * from `stats` / `rarities` / `sets`; only the per-page slice waits here.
 *
 * `getCards()` runs through `loadPrimary` (safeQuery + timeout) so a schema
 * column drift or a pathological scan degrades to an inline error tile instead
 * of crashing the whole `(admin)` route group via error.tsx.
 */
async function CardsContent({
  view,
  filter,
  page,
  perPage,
  sortBy,
  sortOrder,
  isAdmin,
}: {
  view: string;
  filter: CardsFilter;
  page: number;
  perPage: number;
  sortBy?: string;
  sortOrder: "asc" | "desc";
  isAdmin: boolean;
}) {
  const { data: result, error } = await loadPrimary(
    () =>
      getCards({
        page,
        perPage,
        search: filter.search,
        rarity: filter.rarity,
        setId: filter.setId,
        minPrice: filter.minPrice,
        maxPrice: filter.maxPrice,
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
        hint="The cards query failed — most likely a schema field that hasn't reached the live DB yet. Server logs hold the digest."
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
        <CardsExplorer
          data={result.data}
          total={result.total}
          view={view}
          filter={filter}
          isAdmin={isAdmin}
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

/**
 * Streamed KPI strip — the catalog-wide / per-set aggregate (four counts +
 * aggregates over the ~50k-row cards table, cached 60s in `getCardsStats`).
 * Lifted out of the page body into its own async segment so PageHero + the
 * filter/list shell paint immediately instead of blocking on this scan when
 * the cache is cold. Its Suspense boundary is keyed on the active set ONLY
 * (see the page), so paginating / sorting / searching never re-suspends or
 * re-fetches the strip — it persists across those navigations.
 */
async function CardsStatsStrip({
  setId,
  activeSetLabel,
}: {
  setId?: string;
  activeSetLabel: string | null;
}) {
  const { data: stats } = await safeQuery(
    () => getCardsStats(setId),
    null,
    "cards.stats",
  );

  if (!stats) {
    return (
      <TileErrorFallback
        label="Catalog stats"
        hint="The aggregate stats query failed. The cards list below is unaffected — refresh to retry."
      />
    );
  }

  // Quality-bucket counts for dedicated KPI tiles — regex over rarity names
  // (handles Pokemon "Ultra Rare"/"Secret" and OnePiece "SR"/"SEC" short
  // codes).
  const rareCount = stats.byRarity
    .filter(
      (r) =>
        (/rare/i.test(r.rarity) && !/ultra/i.test(r.rarity)) ||
        /^r$/i.test(r.rarity),
    )
    .reduce((sum, r) => sum + r.count, 0);
  const ultraCount = stats.byRarity
    .filter((r) => /(ultra|secret|legendary|^sr$|^sec$|^sp$|^tr$)/i.test(r.rarity))
    .reduce((sum, r) => sum + r.count, 0);

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
      <KpiTile
        label={activeSetLabel ? `Cards in ${activeSetLabel}` : "Total Cards"}
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
  );
}

/**
 * Streamed filter bar — the rarity dropdown options come from a `groupBy` over
 * the cards table (scoped to the active set, cached 60s in `getRarities`).
 * Streamed in its own segment keyed on the active set so it neither blocks
 * first paint nor re-fetches on pagination/sort/search.
 */
async function CardsFilterSection({
  tabs,
  setId,
}: {
  tabs: CardSetTab[];
  setId?: string;
}) {
  const { data: raritiesRaw } = await safeQuery(
    () => getRarities(setId),
    [] as (string | null)[],
    "cards.rarities",
  );
  const rarities = raritiesRaw.filter((r): r is string => r != null);
  return <CardsFilterBar tabs={tabs} rarities={rarities} />;
}

export default async function CardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePageAccess("/cards");
  // Whether to expose the admin-only bulk Delete in the selection toolbar.
  // `sessionIsAdmin` reads the effective role set (multi-role aware), matching
  // the `requireAdmin()` gate the `deleteCards` action enforces server-side.
  const isAdmin = sessionIsAdmin(session);
  const params = await searchParams;

  // Normalize page / perPage(clamped to the allowed set) / sort(whitelisted).
  // Default perPage 40 keeps the dense gallery at 4 rows; the table view reads
  // the same slice.
  const { page, perPage, search, sortBy, sortOrder } = parseListParams(params, {
    defaultPerPage: 40,
    allowedSortFields: CARD_SORT_FIELDS,
    defaultSortBy: "created_at",
    defaultSortOrder: "desc",
  });

  const view = resolveEntityView(params.view);

  // ── Up-front frame deps (small, fast) ─────────────────────────────────────
  // Only the set list is awaited here — it's a tiny two-column read needed to
  // build the tabs, resolve the active scope, and seed the hero's create
  // button. The heavier per-set stats (KPI strip) + rarities (filter options)
  // are streamed in their own Suspense boundaries below. The bulk-move dialog's
  // set list + series options are NOT fetched here either — they're deferred
  // into the dialog's own on-open server action (CLAUDE.md hidden-component
  // rule).
  //
  // safeQuery-wrapped so a failing set read degrades to an empty catalog
  // instead of crashing the page.
  const { data: sets } = await safeQuery(
    () => getSets(),
    [] as Awaited<ReturnType<typeof getSets>>,
    "cards.sets",
  );

  // Build tabs + resolve the active scope (set tab / unassigned / default).
  const tabs = buildSetTabs(sets);
  const activeSet = resolveSetFromParam(params.set, tabs);

  // The effective set filter passed to every scoped query: a real set UUID, the
  // "unassigned" sentinel (set_id IS NULL), or undefined (no catalog at all).
  const effectiveSetId =
    activeSet?.kind === "set"
      ? activeSet.setId
      : activeSet?.kind === "unassigned"
        ? "unassigned"
        : undefined;

  // The active-set stats (KPI strip) and rarities (filter options) are no
  // longer awaited here — they're streamed in their own set-keyed Suspense
  // boundaries below so the heavy aggregate/groupBy never blocks PageHero, the
  // filter shell, or the list, and never re-fetches on pagination/sort/search.

  // Resolved filter predicate handed to the explorer (active-set folded in) so
  // its "select all matching" action matches the visible list exactly.
  const filter: CardsFilter = {
    search,
    rarity: params.rarity,
    setId: effectiveSetId,
    minPrice: params.minPrice,
    maxPrice: params.maxPrice,
  };

  // List Suspense key — keyed on the VIEW ONLY (grid vs table). Rationale:
  //
  //   - A grid⇄table switch changes the key → the boundary unmounts → the
  //     view-matched hard skeleton swaps in. Grid and table need different
  //     skeletons, so a real skeleton swap is the correct treatment there.
  //   - Every OTHER navigation (paginate / sort / search / filter / set tab)
  //     keeps the key STABLE. React therefore does NOT re-show the loading
  //     fallback — App Router keeps the already-rendered count summary + rows
  //     + pagination on screen while the new server payload streams, then swaps
  //     them atomically on commit. That removes the full-list skeleton re-flash
  //     the audit flagged on same-view page/sort/search navigations (the KPI
  //     strip + filter bar already persisted via their own set-keyed
  //     boundaries; only this leg was re-flashing).
  //
  // The global `TopProgressBar` (top of the viewport) remains the in-flight
  // "loading" cue during that stale-content window. A row-level pending DIM is
  // tracked as a follow-up (see the agent report) — it needs the shared
  // pagination / FilterBar controls to expose a `useTransition` pending flag,
  // which is out of this unit's file scope.
  const listViewKey = `list-${view}`;

  const defaultCreateSetId =
    activeSet?.kind === "set" ? activeSet.setId : "";

  return (
    <div className="space-y-6">
      {/* ── HERO ───────────────────────────────────────────────────── */}
      <PageHero>
        <PageHeroIdentity
          action={
            <CreateCardButton sets={sets} defaultSetId={defaultCreateSetId} />
          }
        />
      </PageHero>

      {/* ── KPI STRIP ───────────────────────────────────────────────
           Streamed in its own Suspense keyed on the active set ONLY, so the
           heavy aggregate scan never blocks first paint and never re-suspends
           on pagination/sort/search. On query failure the segment collapses to
           a single TileErrorFallback row instead of zero-ing out every tile;
           the filter bar + list below are unaffected. */}
      <Suspense
        key={`stats-${effectiveSetId ?? "all"}`}
        fallback={<KpiStripSkeleton count={5} />}
      >
        <CardsStatsStrip
          setId={effectiveSetId}
          activeSetLabel={activeSet?.label ?? null}
        />
      </Suspense>

      {/* ── FILTER BAR + LIST ─────────────────────────────────────────
           The filter bar carries the tab switch (leading), search,
           rarity, price range, and the grid⇄table view toggle
           (trailing), with always-visible active-filter chips. */}
      <div className="space-y-3">
        <SectionHeading
          icon={Layers}
          title={activeSet ? activeSet.label : "Catalog"}
        />
        <Suspense
          key={`filter-${effectiveSetId ?? "all"}`}
          fallback={<FilterBarSkeleton filters={1} />}
        >
          <CardsFilterSection tabs={tabs} setId={effectiveSetId} />
        </Suspense>

        <Suspense
          key={listViewKey}
          fallback={
            <>
              {/* Count-summary line ("Showing N of M cards") placeholder. */}
              <Skeleton className="h-4 w-48" />
              {view === "grid" ? (
                <EntityGridSkeleton count={perPage} />
              ) : (
                <EntityTableSkeleton rows={Math.min(perPage, 14)} columns={7} />
              )}
              <EntityPaginationSkeleton />
            </>
          }
        >
          <CardsContent
            view={view}
            filter={filter}
            page={page}
            perPage={perPage}
            sortBy={sortBy}
            sortOrder={sortOrder}
            isAdmin={isAdmin}
          />
        </Suspense>
      </div>
    </div>
  );
}
