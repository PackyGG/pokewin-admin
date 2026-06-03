import { Suspense } from "react";
import { notFound } from "next/navigation";
import {
  Package,
  DollarSign,
  Coins,
  Percent,
  TrendingUp,
  Layers,
  Boxes,
} from "lucide-react";
import { BackButton } from "@/components/back-button";
import { getPackDetail } from "@/lib/queries/packs";
import { getUserPermissions, requirePageAccess, sessionHasRole } from "@/lib/dal";
import { isUuid } from "@/lib/utils/ids";
import { hasCapability } from "@/app/(admin)/settings/roles/permissions-utils";
import { ensurePackCreatorCapabilities } from "@/lib/pack-creator/ensure-capabilities";
import { Badge } from "@/components/ui/badge";
import { CardImage } from "@/components/card-image";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { toPercent } from "@/lib/house-pov";
import {
  PackContentTabsNav,
  PackCardsView,
  parsePackContentTab,
} from "./pack-tabs";
import { GamesTabSection } from "./games-tab-section";
import { PackStatsLazy } from "./pack-stats-section";
import { TogglePackButton } from "./toggle-pack-button";
import { EditPackButton } from "./edit-pack-button";
import { DeletePackButton } from "./delete-pack-button";
import { PageHero, KpiTile, SectionHeading } from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { Skeleton } from "@/components/ui/skeleton";
import { safeQuery } from "@/lib/errors/safe-query";
import { InlineError } from "@/components/entity-surface";

export const metadata = { title: "Pack Detail" };

export default async function PackDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const session = await requirePageAccess("/packs");
  const { id } = await params;
  // Active content tab — parsed server-side so we render ONLY the active
  // tab's data. The "games" tab's feed is a heavy unindexed JSON scan over
  // provably_fair_results, so it's loaded lazily (on click) inside a Suspense
  // boundary below — never eagerly on the default Cards view.
  const packTab = parsePackContentTab((await searchParams).packTab);
  // Shape-check UUID before any DB call — see src/lib/utils/ids.ts.
  if (!isUuid(id)) notFound();

  // Parallelize the two independent kick-offs: the pack fetch and the
  // idempotent pack_creator capability back-fill don't depend on each other,
  // so run them together instead of serially (was 4 sequential awaits before
  // first paint). getUserPermissions still runs AFTER the back-fill so a
  // freshly-granted __can_update_pack is visible in this request's read.
  //
  // getPackDetail is wrapped in safeQuery so a runtime DB fault (connection
  // blip, or a stale Prisma column on the live `packs` table that the
  // worktree schema is ahead of) degrades to an inline error block instead of
  // throwing out of the page body into the (admin) route error boundary — the
  // documented white-screen. A genuine 404 (query OK, row absent) still falls
  // through to notFound() below. ensurePackCreatorCapabilities never re-throws
  // (it self-catches), so it stays a bare await.
  const [{ data, error: detailError }] = await Promise.all([
    safeQuery(() => getPackDetail(id), null, "packs.detail"),
    ensurePackCreatorCapabilities(),
  ]);
  // Query threw → degrade in place (keep the back button + retry usable)
  // rather than crash the whole route. Never notFound() on an error — the
  // pack may well exist; only the read failed.
  if (detailError) {
    return (
      <div className="space-y-6">
        <PageHero>
          <div className="flex items-center gap-3">
            <BackButton />
            <h1 className="text-xl font-semibold leading-tight tracking-tight">
              Pack
            </h1>
          </div>
        </PageHero>
        <InlineError
          title="Couldn't load this pack"
          hint="The pack query failed — most likely a stale Prisma field that hasn't reached the live DB yet, or a transient connection blip. Retry, or head back to the catalog. Server logs hold the digest."
        />
      </div>
    );
  }
  if (!data) notFound();

  // Gate the action buttons by capability so restricted roles (e.g.
  // pack_creator) don't see ghost buttons that error on click. Real admins
  // always pass; non-admins need the explicit __can_* keys.
  const isAdmin = session.role === "admin";
  let canToggle = isAdmin;
  let canEdit = isAdmin;
  let canEditLive = isAdmin;
  let canDelete = isAdmin;
  if (!isAdmin) {
    // safeQuery defaulting to [] so an Admin-DB blip can't crash a
    // pack_creator's detail view — it degrades to "no capabilities", i.e.
    // the action buttons stay hidden (the safe default). Real admins skip
    // this branch entirely.
    const { data: perms } = await safeQuery(
      () => getUserPermissions(session.userId),
      [] as string[],
      "packs.detail.perms",
    );
    canToggle = hasCapability(perms, "__can_toggle_pack_active");
    canEdit = hasCapability(perms, "__can_update_pack");
    canEditLive = hasCapability(perms, "__can_edit_live_packs");
    canDelete = hasCapability(perms, "__can_delete_pack");
  }
  // Pack creators only get to edit packs while they're still in the demo
  // (inactive) state — UNLESS they've been granted __can_edit_live_packs,
  // which lifts that restriction. Mirrors the server-side gate in updatePack
  // so the UI doesn't dangle a button that 500s on click.
  const showEditButton =
    canEdit &&
    (isAdmin ||
      !sessionHasRole(session, "pack_creator") ||
      !data.active ||
      canEditLive);

  // ── Above-the-fold KPI strip — derived from the maintained `packs.*`
  // columns already in `data`, so it needs NO provably_fair scan and paints
  // immediately. Revenue = lifetime opens × price (the same opens×price
  // identity getPackStats computes, and the same source the /packs list uses,
  // so the list and detail figures now AGREE). The two heavy scans behind the
  // charts are deferred to <PackStatsLazy> below the fold.
  const openings = data.totalOpenings;
  const revenue = openings * data.priceUsd;
  const payout = data.totalPayout;
  const rtpPct = toPercent(data.actualRtp);
  const houseEdgePct = 100 - rtpPct;

  return (
    <div className="space-y-6">
      <PageHero>
        {/* Identity row — the pack title is the headline, so it gets a large,
            fully-visible treatment. Pack art shown at a generous size, ringed
            so it reads as the pack's avatar. */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3 sm:gap-4">
            <BackButton />
            <div className="shrink-0 overflow-hidden rounded-xl border bg-muted/40 shadow-sm ring-1 ring-inset ring-white/5">
              <CardImage
                src={data.imageUrl}
                alt={data.name}
                className="h-16 w-16 object-cover sm:h-20 sm:w-20"
              />
            </div>
            <div className="min-w-0 pt-0.5">
              <h1 className="text-2xl font-bold leading-tight tracking-tight sm:text-3xl md:text-4xl">
                {data.name}
              </h1>
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <Badge
                  variant="outline"
                  className={
                    data.active
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                      : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
                  }
                >
                  {data.active ? "Active" : "Inactive"}
                </Badge>
                <Badge variant="outline" className="capitalize">{data.packType}</Badge>
                <span className="font-mono text-xs text-muted-foreground">{data.slug}</span>
              </div>
            </div>
          </div>
          {(canToggle || showEditButton || canDelete) && (
            <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:gap-2">
              {canToggle && (
                <TogglePackButton packId={data.id} active={data.active} />
              )}
              {showEditButton && <EditPackButton pack={data} />}
              {canDelete && (
                <DeletePackButton packId={data.id} packName={data.name} />
              )}
            </div>
          )}
        </div>
      </PageHero>

      {/* KPI strip — 8 stats so we go 2/4/8 across the breakpoints. Derived
          from `data` (maintained columns) — no scan, instant first paint. */}
      <div className="grid gap-2.5 sm:gap-4 grid-cols-2 md:grid-cols-4 lg:grid-cols-8">
        <KpiTile
          label="Price"
          value={formatCurrency(data.priceUsd)}
          icon={DollarSign}
          accent="blue"
        />
        <KpiTile
          label="Openings"
          value={formatNumber(openings)}
          icon={Package}
          accent="cyan"
        />
        {/* Revenue = what users paid to open this pack (house gain, emerald).
            Payout = card value we handed back (house loss, rose). Per CLAUDE.md
            house-POV coloring. */}
        <KpiTile
          label="Revenue"
          value={formatCurrency(revenue)}
          icon={TrendingUp}
          accent="emerald"
        />
        <KpiTile
          label="Payout"
          value={formatCurrency(payout)}
          icon={Coins}
          accent="rose"
        />
        <KpiTile
          label="RTP"
          value={`${rtpPct.toFixed(2)}%`}
          icon={Percent}
          accent={rtpPct > 100 ? "rose" : "purple"}
        />
        <KpiTile
          label="House Edge"
          value={`${houseEdgePct.toFixed(2)}%`}
          icon={TrendingUp}
          accent={houseEdgePct < 0 ? "rose" : "emerald"}
        />
        <KpiTile
          label="Cards/Open"
          value={String(data.cardsPerOpen)}
          icon={Layers}
          accent="pink"
        />
        <KpiTile
          label="Total Cards"
          value={String(data.cards.length)}
          icon={Boxes}
          accent="orange"
        />
      </div>

      {/* Stats charts — DEFERRED behind Suspense so the two heavy JSON scans
          run AFTER the KPI strip + card pool paint, not before. Keyed by pack
          id so navigating between packs re-fetches. */}
      <FadeIn>
        <Suspense
          key={`stats-${id}`}
          fallback={
            <div className="space-y-4">
              {/* Period-tiles card on top, then the two charts. The chart boxes
                  mirror the real Revenue/Openings ChartContainers (h-[250px])
                  so reserving space here prevents a layout jump when the
                  deferred stats scan resolves and the charts paint. */}
              <Skeleton className="h-32 rounded-xl" />
              <div className="grid gap-4 lg:grid-cols-2">
                <Skeleton className="h-[250px] rounded-xl" />
                <Skeleton className="h-[250px] rounded-xl" />
              </div>
            </div>
          }
        >
          <PackStatsLazy
            packId={id}
            packPrice={data.priceUsd}
            totalPayout={data.totalPayout}
            actualRtp={data.actualRtp}
          />
        </Suspense>
      </FadeIn>

      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Boxes} title="Pack Contents" />
          <div className="space-y-4">
            <PackContentTabsNav cardCount={data.cards.length} />
            {packTab === "games" ? (
              // Heavy JSON-scan feed — only mounted when the Games tab is
              // active, so the scan runs on click, not on initial load. Keyed
              // by pack id so navigating between packs re-fetches.
              <Suspense
                key={`games-${id}`}
                fallback={<Skeleton className="h-96 rounded-xl" />}
              >
                <GamesTabSection packId={id} />
              </Suspense>
            ) : (
              // Cards pool is already in hand from getPackDetail — no extra
              // query, renders instantly.
              <PackCardsView cards={data.cards} />
            )}
          </div>
        </div>
      </FadeIn>
    </div>
  );
}
