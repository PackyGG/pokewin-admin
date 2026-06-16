import { Suspense } from "react";
import {
  Coins,
  EyeOff,
  Gauge,
  HandCoins,
  Layers,
  Palette,
  Plus,
  Sparkles,
} from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { safeQuery } from "@/lib/errors/safe-query";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import { getUpgraderPickerFilters, listUpgraderOutputs } from "../actions";
import type { UpgraderOutputCard } from "@/lib/backend-api";
import { AddUpgraderCardsDialog } from "../add-cards-dialog";
import {
  UPGRADER_OUTPUT_COLORS,
  colorForPrice,
  type UpgraderOutputColor,
} from "../colors";
import { UpgraderOutputCardsGrid } from "../output-cards-grid";
import { UpgraderKpiStrip } from "../upgrader-kpi-strip";

/**
 * Hex swatches used in the tier-distribution panel. Mirrors the
 * COLOR_SWATCH map in `output-cards-grid.tsx`, which itself mirrors the
 * game frontend's CARD_RARITY_THEME_MAP auraHex values. Kept inline here
 * to avoid pulling the client-only color module into the server segment.
 */
const TIER_SWATCH: Record<UpgraderOutputColor, string> = {
  gray: "#6E7199",
  white: "#F5F9FF",
  blue: "#00B4F0",
  green: "#5EC22E",
  purple: "#A855F7",
  red: "#FF4545",
  gold: "#FFD700",
};

/**
 * Lower-bound USD price each tier covers. Mirrors `colorForPrice` —
 * shown next to each tier row so an admin can see at a glance which
 * price band a tier represents without opening `colors.ts`.
 */
const TIER_RANGES: Array<{
  color: UpgraderOutputColor;
  from: number;
  to: number | null;
}> = [
  { color: "gray", from: 0, to: 1 },
  { color: "white", from: 1, to: 15 },
  { color: "green", from: 15, to: 150 },
  { color: "blue", from: 150, to: 500 },
  { color: "purple", from: 500, to: 1500 },
  { color: "red", from: 1500, to: 5000 },
  { color: "gold", from: 5000, to: null },
];

function tierRangeLabel(from: number, to: number | null): string {
  if (to === null) return `${formatCurrency(from)}+`;
  return `${formatCurrency(from)} – ${formatCurrency(to)}`;
}

/**
 * Resolve the tier-color for a card the same way the picker does:
 * manual override wins, otherwise the price-derived band.
 */
function resolveTier(card: {
  color: string | null;
  price: number;
}): UpgraderOutputColor {
  const manual = (UPGRADER_OUTPUT_COLORS as readonly string[]).includes(
    card.color ?? "",
  )
    ? (card.color as UpgraderOutputColor)
    : null;
  return manual ?? colorForPrice(card.price);
}

/**
 * "Catalog" tab content for the merged Upgrader surface (/upgrader). Lifted
 * verbatim from the former standalone /upgrader page body (only the PageHero
 * moved up to the shared page shell; the AddCards action moved from the hero
 * into the Output Cards section heading, since it depends on this segment's
 * data fetch). The page already enforced `requirePageAccess("/upgrader")`
 * before mounting this.
 *
 * Mounted inside the page's `<Suspense>` so its backend-API + main-DB reads
 * only run when the Catalog tab is active (Active-Tab-Only).
 */
export async function UpgraderCatalogTab({
  searchParams,
}: {
  searchParams: Record<string, string | undefined>;
}) {
  const params = searchParams;
  const page = Number(params.page) || 1;
  // Match the 8-col xl grid so a default page fills 5 rows neatly.
  const perPage = Number(params.perPage) || 40;
  const searchTerm = params.search?.trim().toLowerCase() ?? "";
  const statusFilter = params.status ?? "all";
  const tierFilter = params.tier ?? "all";

  // The canonical pool fetch is wrapped in safeQuery so a backend-API blip
  // (listUpgraderOutputs calls the website backend over HTTP) degrades to a
  // panel-level error instead of taking the whole tab down. 12s timeout
  // matches the entity-surface PRIMARY_QUERY_TIMEOUT_MS used on /cards + /packs.
  //
  // The picker filters (getUpgraderPickerFilters → getSets + getRarities)
  // feed ONLY the Add Cards dialog, so they no longer gate this segment:
  // they're fetched in a nested <Suspense> (UpgraderAddCardsAction) and
  // stream into the section-heading action independently. The KPI strip,
  // tier panel and grid all derive from `outputs` alone, so they now paint
  // at listUpgraderOutputs() latency instead of waiting on the slower of the
  // two — same values, earlier first paint.
  const outputsResult = await safeQuery(
    () => listUpgraderOutputs(),
    [] as UpgraderOutputCard[],
    "upgrader.list",
    12_000,
  );

  // If the canonical pool fetch failed there is nothing to derive the KPI
  // strip, tier panel, or grid from — render a single panel-level error tile
  // so the admin still sees the chrome (and can refresh) instead of crashing
  // the tab. The AddCards dialog is hidden because it needs an
  // `existingCardIds` list we can't trust.
  if (outputsResult.error) {
    return (
      <TileErrorFallback
        label="Upgrader output pool"
        hint="The output-pool fetch failed (backend API timed out or returned an error). Refresh to retry."
        size="panel"
      />
    );
  }

  const outputs = outputsResult.data;

  // KPI strip + tier panel read the FULL pool so they stay stable while admins
  // refine the grid filters below.
  const total = outputs.length;
  const enabled = outputs.filter((c) => c.enabled).length;
  const disabled = total - enabled;
  const totalValue = outputs.reduce((sum, c) => sum + c.price, 0);
  const avgPrice = total > 0 ? totalValue / total : 0;
  const maxPrice = outputs.reduce((max, c) => Math.max(max, c.price), 0);
  const existingCardIds = outputs.map((c) => c.card_id);

  // Tier distribution — count cards AND sum their value per color tier
  // (manual override wins, otherwise price-derived). Drives the breakdown
  // panel and the toolbar Tier filter options so both stay in sync.
  const tierCounts = new Map<UpgraderOutputColor, number>();
  const tierValues = new Map<UpgraderOutputColor, number>();
  for (const c of UPGRADER_OUTPUT_COLORS) {
    tierCounts.set(c, 0);
    tierValues.set(c, 0);
  }
  for (const card of outputs) {
    const tier = resolveTier(card);
    tierCounts.set(tier, (tierCounts.get(tier) ?? 0) + 1);
    tierValues.set(tier, (tierValues.get(tier) ?? 0) + card.price);
  }
  // Pre-compute the dominant tier BY VALUE so its row gets a subtle highlight
  // — points the operator at the slice of the pool that carries the most
  // payout liability, not just the most rows.
  const dominantTier =
    totalValue > 0
      ? Array.from(tierValues.entries()).reduce<{
          tier: UpgraderOutputColor;
          v: number;
        } | null>((best, [tier, v]) => {
          if (best === null || v > best.v) return { tier, v };
          return best;
        }, null)?.tier ?? null
      : null;

  // ── Filter + paginate the pool for the grid ────────────────────────
  // The backend's GET /admin/upgrader/outputs returns the whole pool in one
  // shot — there's no server-side search/filter/pagination API to delegate to.
  // We sort/search/slice in-process here so the grid still gets the same
  // toolbar + paginator UX as the rest of the admin app.
  const filtered = outputs.filter((c) => {
    if (statusFilter === "enabled" && !c.enabled) return false;
    if (statusFilter === "disabled" && c.enabled) return false;
    if (
      tierFilter !== "all" &&
      (UPGRADER_OUTPUT_COLORS as readonly string[]).includes(tierFilter) &&
      resolveTier(c) !== tierFilter
    ) {
      return false;
    }
    if (searchTerm && !c.name.toLowerCase().includes(searchTerm)) {
      return false;
    }
    return true;
  });
  const filteredTotal = filtered.length;
  const totalPages = Math.max(1, Math.ceil(filteredTotal / perPage));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const pageStart = (safePage - 1) * perPage;
  const pageSlice = filtered.slice(pageStart, pageStart + perPage);

  return (
    <div className="space-y-6">
      {/* ── KPI STRIP ─────────────────────────────────────────────────
          House-POV coloring (CLAUDE.md): the output pool is what a player can
          WIN, so its dollar size is payout liability — money the house may owe.
          Pool Liability + Avg Payout are therefore ROSE (user gain). Pool
          composition counts (total / enabled / disabled) carry no win/loss
          direction, so they keep neutral informational accents. */}
      <UpgraderKpiStrip
        items={[
          {
            label: "Cards in Pool",
            value: total,
            format: "number",
            sub: total > 0 ? `${enabled} live · ${disabled} hidden` : "Empty",
            icon: Layers,
            accent: "blue",
          },
          {
            label: "Live",
            value: enabled,
            format: "number",
            sub:
              total > 0
                ? `${Math.round((enabled / total) * 100)}% of pool playable`
                : undefined,
            icon: Sparkles,
            accent: "cyan",
          },
          {
            label: "Hidden",
            value: disabled,
            format: "number",
            sub: disabled > 0 ? "Excluded from picker" : "All cards live",
            icon: EyeOff,
            accent: "amber",
          },
          {
            label: "Avg Payout",
            value: avgPrice,
            format: "currency",
            sub: maxPrice > 0 ? `top ${formatCurrency(maxPrice)}` : undefined,
            icon: Gauge,
            accent: "rose",
          },
          {
            label: "Pool Liability",
            value: totalValue,
            format: "currency",
            sub:
              total > 0
                ? `across ${formatNumber(total)} card${total === 1 ? "" : "s"}`
                : undefined,
            icon: HandCoins,
            accent: "rose",
          },
        ]}
      />

      {/* ── TIER DISTRIBUTION ───────────────────────────────────────── */}
      {total > 0 && (
        <FadeIn>
          <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70">
            <div
              aria-hidden
              className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-amber-500/10 blur-3xl"
            />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent"
            />
            <div className="relative p-4 sm:p-5">
              <SectionHeading
                icon={Palette}
                title="Liability by Tier"
                action={
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-rose-500/30 bg-rose-500/10 px-2.5 py-0.5 text-[11px] font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                    <HandCoins className="size-3" />
                    {formatCurrency(totalValue)} total
                  </span>
                }
              />
              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {TIER_RANGES.map(({ color, from, to }) => {
                  const count = tierCounts.get(color) ?? 0;
                  const value = tierValues.get(color) ?? 0;
                  const share =
                    totalValue > 0 ? (value / totalValue) * 100 : 0;
                  const isDominant = color === dominantTier && value > 0;
                  return (
                    <div
                      key={color}
                      className={cn(
                        "relative overflow-hidden rounded-xl border bg-background/40 p-3 transition-colors",
                        isDominant
                          ? "border-amber-500/40 bg-amber-500/[0.04]"
                          : "border-border/60",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            aria-hidden
                            className="inline-block size-3 shrink-0 rounded-full border border-border/40 shadow-sm"
                            style={{ backgroundColor: TIER_SWATCH[color] }}
                          />
                          <span className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                            {color}
                          </span>
                        </div>
                        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                          {tierRangeLabel(from, to)}
                        </span>
                      </div>
                      <div className="mt-2 flex items-baseline justify-between gap-2">
                        <span className="truncate text-lg font-bold tabular-nums">
                          {formatCurrency(value)}
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                          {share.toFixed(1)}%
                        </span>
                      </div>
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-border/40">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${Math.min(100, share)}%`,
                            backgroundColor: TIER_SWATCH[color],
                            opacity: value > 0 ? 0.85 : 0,
                          }}
                          aria-hidden
                        />
                      </div>
                      <p className="mt-2 text-[10px] text-muted-foreground tabular-nums">
                        {formatNumber(count)} card{count === 1 ? "" : "s"}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </FadeIn>
      )}

      {/* ── OUTPUT CARDS GRID ─────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeading
          icon={Coins}
          title={
            total > 0 ? `Output Cards · ${formatNumber(total)}` : "Output Cards"
          }
          // AddCards lived in the page hero on the standalone page; it moved
          // here because it depends on this segment's data fetch
          // (existingCardIds / sets / rarities), which the page shell can't
          // resolve without eager-loading the pool on the Transactions tab.
          action={
            <Suspense fallback={<AddCardsActionFallback />}>
              <UpgraderAddCardsAction existingCardIds={existingCardIds} />
            </Suspense>
          }
        />
        <Suspense fallback={<Skeleton className="h-10 w-full" />}>
          <DataTableToolbar
            searchPlaceholder="Search by card name..."
            filters={[
              {
                name: "Status",
                paramKey: "status",
                options: [
                  { label: "Enabled", value: "enabled" },
                  { label: "Disabled", value: "disabled" },
                ],
              },
              {
                name: "Tier",
                paramKey: "tier",
                options: UPGRADER_OUTPUT_COLORS.map((c) => ({
                  label: c.charAt(0).toUpperCase() + c.slice(1),
                  value: c,
                })),
              },
            ]}
          />
        </Suspense>
        <FadeIn>
          <UpgraderOutputCardsGrid data={pageSlice} poolTotal={total} />
        </FadeIn>
        <DataTablePagination
          page={safePage}
          totalPages={totalPages}
          total={filteredTotal}
          perPage={perPage}
        />
      </div>
    </div>
  );
}

/**
 * Placeholder for the Add Cards trigger while its picker filters
 * (getSets + getRarities) stream in. Mirrors the dialog's trigger button
 * (same `gap-2` + Plus icon) but disabled, so the section heading keeps its
 * shape and the button doesn't pop in — it just enables once the filters
 * resolve.
 */
function AddCardsActionFallback() {
  return (
    <Button className="gap-2" disabled>
      <Plus className="size-4" />
      Add Cards
    </Button>
  );
}

/**
 * Streams the Add Cards dialog independently of the catalog's main content.
 * The picker filters feed ONLY the dialog's rarity/set dropdowns, so they're
 * fetched here (behind the page's <Suspense>) instead of gating the KPI
 * strip / tier panel / grid. `existingCardIds` is derived from the already
 * resolved pool and threaded in. safeQuery degrades a filters fault to empty
 * dropdowns (dialog still opens) rather than crashing the tab — same value
 * behavior as the previous inline fallback.
 */
async function UpgraderAddCardsAction({
  existingCardIds,
}: {
  existingCardIds: string[];
}) {
  const filtersResult = await safeQuery(
    () => getUpgraderPickerFilters(),
    { sets: [], rarities: [] } as Awaited<
      ReturnType<typeof getUpgraderPickerFilters>
    >,
    "upgrader.filters",
    12_000,
  );
  const filters = filtersResult.data;
  return (
    <AddUpgraderCardsDialog
      existingCardIds={existingCardIds}
      sets={filters.sets}
      rarities={filters.rarities}
    />
  );
}
