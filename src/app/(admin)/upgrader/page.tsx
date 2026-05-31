import { Suspense } from "react";
import {
  Coins,
  EyeOff,
  Gauge,
  Layers,
  Palette,
  Sparkles,
  Wallet,
  Zap,
} from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import {
  KpiTile,
  PageHero,
  PageHeroIdentity,
  SectionHeading,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import { DataTableToolbar } from "@/components/data-table/data-table-toolbar";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";

import {
  getUpgraderPickerFilters,
  listUpgraderOutputs,
} from "./actions";
import { AddUpgraderCardsDialog } from "./add-cards-dialog";
import {
  UPGRADER_OUTPUT_COLORS,
  colorForPrice,
  type UpgraderOutputColor,
} from "./colors";
import { UpgraderOutputCardsGrid } from "./output-cards-grid";

export const metadata = { title: "Upgrader" };

/**
 * Hex swatches used in the tier-distribution panel. Mirrors the
 * COLOR_SWATCH map in `output-cards-grid.tsx`, which itself mirrors the
 * game frontend's CARD_RARITY_THEME_MAP auraHex values. Kept inline here
 * to avoid pulling the client-only color module into the server page.
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
 *
 * Stored as { color, from, to } pairs in display order (cheapest →
 * priciest, matching the rarity-ascending feel of the upgrader UI).
 * `to` is exclusive; the last tier (`gold`) has no upper bound.
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
  // The from-bound is the tier's floor — render the band closed-open
  // to mirror colors.ts's `< to` comparison while staying readable.
  return `${formatCurrency(from)} – ${formatCurrency(to)}`;
}

/**
 * Resolve the tier-color for a card the same way the picker does:
 * manual override wins, otherwise the price-derived band. Used for
 * both the global tier-distribution panel and the toolbar Tier filter
 * so a card surfaced under "purple" in the breakdown is the same set
 * the filter narrows the grid to.
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

export default async function UpgraderAdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/upgrader");

  const params = await searchParams;
  const page = Number(params.page) || 1;
  // Match the 8-col xl grid so a default page fills 5 rows neatly.
  const perPage = Number(params.perPage) || 40;
  const searchTerm = params.search?.trim().toLowerCase() ?? "";
  const statusFilter = params.status ?? "all";
  const tierFilter = params.tier ?? "all";

  const [outputs, filters] = await Promise.all([
    listUpgraderOutputs(),
    getUpgraderPickerFilters(),
  ]);

  // KPI strip + tier panel read the FULL pool so they stay stable
  // while admins refine the grid filters below — same principle as
  // /users where the hero counts ignore the current page/search.
  const total = outputs.length;
  const enabled = outputs.filter((c) => c.enabled).length;
  const disabled = total - enabled;
  const totalValue = outputs.reduce((sum, c) => sum + c.price, 0);
  const avgPrice = total > 0 ? totalValue / total : 0;
  const maxPrice = outputs.reduce((max, c) => Math.max(max, c.price), 0);
  const existingCardIds = outputs.map((c) => c.card_id);

  // Tier distribution — count cards per color tier (manual override
  // wins, otherwise priced-derived). Drives the breakdown panel and
  // the toolbar Tier filter options so both stay in sync.
  const tierCounts = new Map<UpgraderOutputColor, number>();
  for (const c of UPGRADER_OUTPUT_COLORS) tierCounts.set(c, 0);
  for (const card of outputs) {
    const tier = resolveTier(card);
    tierCounts.set(tier, (tierCounts.get(tier) ?? 0) + 1);
  }
  // Pre-compute the dominant tier so its row gets a subtle highlight —
  // helps an operator scan the pool's center of gravity at a glance.
  const dominantTier = total > 0
    ? Array.from(tierCounts.entries()).reduce<{
        tier: UpgraderOutputColor;
        n: number;
      } | null>((best, [tier, n]) => {
        if (best === null || n > best.n) return { tier, n };
        return best;
      }, null)?.tier ?? null
    : null;

  // ── Filter + paginate the pool for the grid ────────────────────────
  // The backend's GET /admin/upgrader/outputs returns the whole pool in
  // one shot — there's no server-side search/filter/pagination API to
  // delegate to. We sort/search/slice in-process here so the grid still
  // gets the same toolbar + paginator UX as the rest of the admin app.
  // The pool is operator-managed (manual add only, bounded in practice)
  // so an in-memory sort of the unfiltered list is fine; if it ever
  // grows to push this past a few KB we'd push the filtering down to
  // the backend instead of paging client-side.
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
  // Default order matches the existing list (newest first by created_at
  // descending). The backend already returns rows in that order; the
  // filtering above preserves it.
  const filteredTotal = filtered.length;
  const totalPages = Math.max(1, Math.ceil(filteredTotal / perPage));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const pageStart = (safePage - 1) * perPage;
  const pageSlice = filtered.slice(pageStart, pageStart + perPage);

  return (
    <div className="space-y-6">
      {/* ── HERO ───────────────────────────────────────────────────── */}
      <PageHero>
        <PageHeroIdentity
          icon={Zap}
          accent="amber"
          title="Upgrader"
          subtitle="Manage the output card pool the upgrader wheel pulls from. Disable a card to hide it from the player picker without removing it."
          action={
            <AddUpgraderCardsDialog
              existingCardIds={existingCardIds}
              sets={filters.sets}
              rarities={filters.rarities}
            />
          }
        />
      </PageHero>

      {/* ── KPI STRIP ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <KpiTile
          label="Total in Pool"
          value={formatNumber(total)}
          sub={total > 0 ? `${enabled} live · ${disabled} hidden` : undefined}
          icon={Layers}
          accent="blue"
        />
        <KpiTile
          label="Enabled"
          value={formatNumber(enabled)}
          sub={
            total > 0
              ? `${Math.round((enabled / total) * 100)}% of pool`
              : undefined
          }
          icon={Sparkles}
          accent="emerald"
        />
        <KpiTile
          label="Disabled"
          value={formatNumber(disabled)}
          sub={
            disabled > 0 ? "Hidden from picker" : "All cards live"
          }
          icon={EyeOff}
          accent="amber"
        />
        <KpiTile
          label="Avg. Price"
          value={formatCurrency(avgPrice)}
          sub={maxPrice > 0 ? `max ${formatCurrency(maxPrice)}` : undefined}
          icon={Gauge}
          accent="purple"
        />
        <KpiTile
          label="Pool Value"
          value={formatCurrency(totalValue)}
          sub={total > 0 ? `${total} card${total === 1 ? "" : "s"} combined` : undefined}
          icon={Wallet}
          accent="cyan"
        />
      </div>

      {/* ── TIER DISTRIBUTION ─────────────────────────────────────── */}
      {/* Surfaces the price-tier mix of the current pool. Tiers mirror
          `colorForPrice` (the auto-assigned tone) so the breakdown
          stays in sync with what the player actually sees in the
          upgrader UI. Manual color overrides win over the price-
          derived tier. Hidden when the pool is empty — the grid below
          already explains how to populate it. */}
      {total > 0 && (
        <FadeIn>
          <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70">
            {/* Soft amber corner glow keeps the panel tied to the page's
                Zap-tinted hero without competing with the per-tier
                accent dots inside the panel. */}
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
                title="Tier Distribution"
              />
              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                {TIER_RANGES.map(({ color, from, to }) => {
                  const count = tierCounts.get(color) ?? 0;
                  const share = total > 0 ? (count / total) * 100 : 0;
                  const isDominant = color === dominantTier && count > 0;
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
                        <span className="text-xl font-bold tabular-nums">
                          {formatNumber(count)}
                        </span>
                        <span className="text-[11px] text-muted-foreground tabular-nums">
                          {share.toFixed(1)}%
                        </span>
                      </div>
                      {/* Share bar — proportional to the tier's count
                          versus the entire pool. Uses the tier's swatch
                          hue so the row reads as a single unit even
                          without the dot. */}
                      <div className="mt-2 h-1 overflow-hidden rounded-full bg-border/40">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${Math.min(100, share)}%`,
                            backgroundColor: TIER_SWATCH[color],
                            opacity: count > 0 ? 0.85 : 0,
                          }}
                          aria-hidden
                        />
                      </div>
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
            total > 0
              ? `Output Cards · ${formatNumber(total)}`
              : "Output Cards"
          }
        />
        <Suspense fallback={<Skeleton className="h-10 w-full" />}>
          {/* Status + tier filters mirror the toolbar pattern used on
              /users / /cards / /packs. Tier options are the same
              UPGRADER_OUTPUT_COLORS allowlist the grid renders — no
              extra labels needed. Server applies the filters in-memory
              against the pre-fetched pool (no backend API supports
              per-row filtering yet). */}
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
