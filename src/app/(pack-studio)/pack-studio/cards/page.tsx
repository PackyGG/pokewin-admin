import { Suspense } from "react";
import { Layers, Library, Gem, Crown, Coins, ShieldCheck } from "lucide-react";

import {
  PageHero,
  PageHeroIdentity,
  KpiTile,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { KpiStripSkeleton } from "@/components/loading-skeletons";
import {
  EntityTableSkeleton,
  EntityGridSkeleton,
  FilterBarSkeleton,
  EntityPaginationSkeleton,
  resolveEntityView,
} from "@/components/entity-surface";
import { safeQuery } from "@/lib/errors/safe-query";
import { loadPrimary, parseListParams } from "@/lib/entity-surface/loader";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  getCards,
  getCardsStats,
  getRarities,
  getSets,
  CARD_SORT_FIELDS,
} from "@/lib/queries/cards";
import { requirePackStudioPageAccess } from "@/lib/require-pack-studio-access";
import { sessionIsAdmin } from "@/lib/dal";

import {
  CardsExplorer,
  type CardsFilter,
} from "./cards-explorer";
import {
  CardsFilterBar,
  type CardSetOption,
} from "./cards-filter-bar";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Pack Studio · Card Editor  (/pack-studio/cards)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The catalog grooming surface for Pack Studio. Reuses the shared `getCards`
 * read + the `entity-surface` foundation, gated by `requirePackStudioPageAccess`
 * (NOT the `/cards` page gate), and adds the Card-Editor deliverables: a usage /
 * safety column and an admin-only, audited "Delete all unused" flow.
 *
 * Shell-first streaming (CLAUDE.md): the hero paints immediately; the KPI strip,
 * filter bar, and list each stream behind their own `<Suspense>` boundary
 * (matching `loading.tsx`). Only the active set + active page slice load — no
 * eager fan-out.
 */

const UNASSIGNED = "unassigned";

export const metadata = { title: "Card Editor" };

/**
 * Resolve the `?set=` param to an effective set filter. A real UUID stays as-is;
 * the "unassigned" sentinel maps to set_id IS NULL; anything else (or absent)
 * means the whole catalog. Returns the value the scoped queries consume
 * (`undefined` = catalog-wide).
 */
function resolveSetParam(
  raw: string | undefined,
  setIds: Set<string>,
): { effectiveSetId: string | undefined; label: string | null } {
  if (raw === UNASSIGNED) {
    return { effectiveSetId: UNASSIGNED, label: "Unassigned" };
  }
  if (raw && setIds.has(raw)) {
    return { effectiveSetId: raw, label: null };
  }
  return { effectiveSetId: undefined, label: null };
}

async function CardsContent({
  view,
  filter,
  unusedOnly,
  page,
  perPage,
  sortBy,
  sortOrder,
  isAdmin,
}: {
  view: string;
  filter: CardsFilter;
  unusedOnly: boolean;
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
    "pack-studio.cards.list",
  );

  if (error || !result) {
    return (
      <TileErrorFallback
        label="Card catalog"
        hint="The cards query failed — server logs hold the digest."
        size="panel"
      />
    );
  }

  return (
    <>
      <FadeIn>
        <CardsExplorer
          data={result.data}
          total={result.total}
          view={view}
          filter={filter}
          unusedOnly={unusedOnly}
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

async function CardsStatsStrip({
  setId,
  setLabel,
}: {
  setId: string | undefined;
  setLabel: string | null;
}) {
  // The catalog-wide stats query only accepts a real set UUID; for the
  // "unassigned" sentinel (set_id IS NULL) the aggregate isn't scoped (the
  // helper has no NULL-set mode), so fall back to catalog-wide there.
  const scopedSetId = setId === UNASSIGNED ? undefined : setId;
  const { data: stats } = await safeQuery(
    () => getCardsStats(scopedSetId),
    null,
    "pack-studio.cards.stats",
  );

  if (!stats) {
    return (
      <TileErrorFallback
        label="Catalog stats"
        hint="The aggregate stats query failed. The list below is unaffected."
      />
    );
  }

  const rareCount = stats.byRarity
    .filter(
      (r) =>
        (/rare/i.test(r.rarity) && !/ultra/i.test(r.rarity)) ||
        /^r$/i.test(r.rarity),
    )
    .reduce((sum, r) => sum + r.count, 0);
  const ultraCount = stats.byRarity
    .filter((r) =>
      /(ultra|secret|legendary|^sr$|^sec$|^sp$|^tr$)/i.test(r.rarity),
    )
    .reduce((sum, r) => sum + r.count, 0);

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
      <KpiTile
        label={setLabel ? `Cards in ${setLabel}` : "Total Cards"}
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

async function CardsFilterSection({
  setOptions,
  setId,
}: {
  setOptions: CardSetOption[];
  setId: string | undefined;
}) {
  const scopedSetId = setId === UNASSIGNED ? UNASSIGNED : setId;
  const { data: raritiesRaw } = await safeQuery(
    () => getRarities(scopedSetId),
    [] as (string | null)[],
    "pack-studio.cards.rarities",
  );
  const rarities = raritiesRaw.filter((r): r is string => r != null);
  return <CardsFilterBar setOptions={setOptions} rarities={rarities} />;
}

export default async function CardEditorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePackStudioPageAccess();
  const isAdmin = sessionIsAdmin(session);
  const params = await searchParams;

  const { page, perPage, search, sortBy, sortOrder } = parseListParams(params, {
    defaultPerPage: 40,
    allowedSortFields: CARD_SORT_FIELDS,
    defaultSortBy: "created_at",
    defaultSortOrder: "desc",
  });

  const view = resolveEntityView(params.view);
  const unusedOnly = params.unused === "1";

  // Small, fast frame read — the set list seeds the filter's set select and
  // resolves the active scope. Heavier stats / rarities stream below.
  const { data: sets } = await safeQuery(
    () => getSets(),
    [] as Awaited<ReturnType<typeof getSets>>,
    "pack-studio.cards.sets",
  );

  const setIds = new Set(sets.map((s) => s.id));
  const { effectiveSetId, label: resolvedLabel } = resolveSetParam(
    params.set,
    setIds,
  );

  // Build the set <Select> options: every set (alpha) + the Unassigned backlog.
  const setOptions: CardSetOption[] = [
    ...sets
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((s) => ({ value: s.id, label: s.name })),
    { value: UNASSIGNED, label: "Unassigned" },
  ];

  const activeSetLabel =
    resolvedLabel ??
    (effectiveSetId && effectiveSetId !== UNASSIGNED
      ? (sets.find((s) => s.id === effectiveSetId)?.name ?? null)
      : null);

  const filter: CardsFilter = {
    search,
    rarity: params.rarity,
    setId: effectiveSetId,
    minPrice: params.minPrice,
    maxPrice: params.maxPrice,
  };

  const suspenseKey = [
    view,
    effectiveSetId ?? "",
    unusedOnly ? "1" : "0",
    page,
    perPage,
    search ?? "",
    params.rarity ?? "",
    params.minPrice ?? "",
    params.maxPrice ?? "",
    sortBy ?? "",
    sortOrder,
  ].join("|");

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Layers}
          accent="purple"
          title="Card Editor"
          subtitle="Browse the catalog, spot unused cards, and clean up safely-deletable ones."
        />
      </PageHero>

      <Suspense
        key={`stats-${effectiveSetId ?? "all"}`}
        fallback={<KpiStripSkeleton count={5} />}
      >
        <CardsStatsStrip setId={effectiveSetId} setLabel={activeSetLabel} />
      </Suspense>

      <div className="space-y-3">
        <SectionHeading
          icon={ShieldCheck}
          title={activeSetLabel ? activeSetLabel : "Catalog"}
        />
        <Suspense
          key={`filter-${effectiveSetId ?? "all"}`}
          fallback={<FilterBarSkeleton filters={2} />}
        >
          <CardsFilterSection setOptions={setOptions} setId={effectiveSetId} />
        </Suspense>

        <Suspense
          key={suspenseKey}
          fallback={
            <>
              <Skeleton className="h-4 w-48" />
              {view === "grid" ? (
                <EntityGridSkeleton count={perPage} />
              ) : (
                <EntityTableSkeleton rows={Math.min(perPage, 14)} columns={6} />
              )}
              <EntityPaginationSkeleton />
            </>
          }
        >
          <CardsContent
            view={view}
            filter={filter}
            unusedOnly={unusedOnly}
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
