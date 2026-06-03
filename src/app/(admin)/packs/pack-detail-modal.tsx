"use client";

import * as React from "react";
import {
  Boxes,
  Coins,
  DollarSign,
  Gamepad2,
  Layers,
  Package,
  Percent,
  TrendingUp,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { CardImage } from "@/components/card-image";
import { KpiTile } from "@/components/modern-panels";
import { InlineError } from "@/components/entity-surface";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { toPercent } from "@/lib/house-pov";
import { cn } from "@/lib/utils";
import type { PackListItem } from "@/lib/queries/packs";
import { PackStatsSection } from "./[id]/revenue-chart";
import { PackCardsView, GamesTable } from "./[id]/pack-tabs";
import {
  fetchPackFullDetail,
  fetchPackGames,
  type PackFullDetail,
} from "./actions";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  PackDetailModal  (pokewin-admin · /packs)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * The big CENTERED modal a /packs list row/tile opens — the in-app replacement
 * for navigating to /packs/[id]. It carries the SAME content the full page
 * shows: the identity hero, the 8-tile economics KPI strip, the deferred chart
 * stats (Revenue/Payout + Daily-Openings + the two breakdown pies), and the
 * Cards / Games content tabs — all reusing the very components the page renders
 * (PackStatsSection, PackCardsView, GamesTable). No rebuild.
 *
 * Laziness contract (CLAUDE.md Active-View-Only):
 *   - The /packs list never eager-loads any pack's detail. The full detail is
 *     fetched on the modal's FIRST open per pack (fetchPackFullDetail) and
 *     cached in a per-pack map, so re-opening the same pack is instant and no
 *     hidden detail work runs before a click.
 *   - The Games tab's feed (an unindexed JSON scan) is itself only fetched when
 *     the operator switches to the Games tab — never on the default Cards view.
 *
 * There is NO standalone full-page pack view anymore: this modal is the only
 * detail surface. The /packs/[id] route just `redirect`s to /packs?inspect=<id>
 * so any direct URL / external deep-link lands on the list with THIS modal open.
 */

type ModalState =
  | { status: "loading" }
  | { status: "ready"; payload: PackFullDetail }
  | { status: "notfound" }
  | { status: "error" };

type ContentTab = "cards" | "games";

export function PackDetailModal({
  pack,
  open,
  onOpenChange,
}: {
  /** The clicked row's list item — seeds the header instantly; null when none. */
  pack: PackListItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Big + centered: override the primitive's default sm:max-w-sm with a
        // wide modal and a tall scroll cap. DialogContent is already a
        // centered (sm:top-1/2 left-1/2), vertically-scrollable flex column,
        // so the long detail body scrolls INSIDE the modal.
        className="sm:max-w-5xl lg:max-w-6xl sm:w-[calc(100%-3rem)] sm:max-h-[90vh] gap-0 p-0"
        showCloseButton
      >
        {pack ? (
          <ModalInner pack={pack} open={open} />
        ) : (
          // Defensive: never render an empty dialog with no a11y title.
          <div className="p-6">
            <DialogTitle className="sr-only">Pack</DialogTitle>
            <Skeleton className="h-40 w-full rounded-xl" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ModalInner({ pack, open }: { pack: PackListItem; open: boolean }) {
  // Per-pack cache so re-opening the SAME pack doesn't refetch. Keyed by pack
  // id; survives close/reopen for the lifetime of the list mount.
  const cacheRef = React.useRef<Map<string, PackFullDetail>>(new Map());
  const [state, setState] = React.useState<ModalState>(() => {
    const cached = cacheRef.current.get(pack.id);
    return cached
      ? { status: "ready", payload: cached }
      : { status: "loading" };
  });
  const [tab, setTab] = React.useState<ContentTab>("cards");

  const load = React.useCallback(
    (id: string) => {
      const cached = cacheRef.current.get(id);
      if (cached) {
        setState({ status: "ready", payload: cached });
        return () => {};
      }
      let cancelled = false;
      setState({ status: "loading" });
      fetchPackFullDetail(id)
        .then((res) => {
          if (cancelled) return;
          if (!res) {
            setState({ status: "notfound" });
            return;
          }
          cacheRef.current.set(id, res);
          setState({ status: "ready", payload: res });
        })
        .catch(() => {
          if (!cancelled) setState({ status: "error" });
        });
      return () => {
        cancelled = true;
      };
    },
    [],
  );

  // Fetch on (first) open per pack. Reset the active tab to Cards whenever the
  // pack changes so a fresh open never lands on a stale Games tab.
  React.useEffect(() => {
    if (!open) return;
    setTab("cards");
    return load(pack.id);
  }, [open, pack.id, load]);

  const detail = state.status === "ready" ? state.payload.detail : null;

  // Header identity falls back to the row's already-known fields while the
  // full detail streams in, so the modal never flashes an empty header.
  const title = detail?.name ?? pack.name;
  const slug = detail?.slug ?? pack.slug;
  const imageUrl = detail?.imageUrl ?? pack.imageUrl;
  const active = detail?.active ?? pack.active;
  const packType = detail?.packType ?? null;

  return (
    <>
      {/* ── Header: art + name + badges. Sticky so it stays in
          view while the long body scrolls. ── */}
      <DialogHeader className="sticky top-0 z-10 -mx-0 border-b bg-background/95 px-4 py-4 backdrop-blur-sm supports-backdrop-filter:bg-background/80 sm:px-6">
        <div className="flex items-start gap-3 pr-10 sm:gap-4">
          <div className="shrink-0 overflow-hidden rounded-xl border bg-muted/40 shadow-sm ring-1 ring-inset ring-white/5">
            <CardImage
              src={imageUrl}
              alt={title}
              className="size-14 object-cover sm:size-16"
            />
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <DialogTitle className="truncate text-lg font-bold leading-tight tracking-tight sm:text-2xl">
              {title}
            </DialogTitle>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Badge
                variant="outline"
                className={
                  active
                    ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30"
                    : "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30"
                }
              >
                {active ? "Active" : "Inactive"}
              </Badge>
              {packType && (
                <Badge variant="outline" className="capitalize">
                  {packType}
                </Badge>
              )}
              <DialogDescription
                render={<span />}
                className="font-mono text-xs text-muted-foreground"
              >
                {slug}
              </DialogDescription>
            </div>
          </div>
        </div>
      </DialogHeader>

      {/* ── Body: the full detail content, scrolling inside the modal. ── */}
      <div className="space-y-5 px-4 py-5 sm:px-6">
        {state.status === "loading" && <ModalBodySkeleton />}

        {state.status === "notfound" && (
          <InlineError
            title="Pack not found"
            hint="This pack may have been deleted. Close this and refresh the catalog."
            compact
          />
        )}

        {state.status === "error" && (
          <InlineError
            title="Couldn't load this pack"
            hint="The pack detail failed to load — a transient connection blip or a slow scan. Retry, or close this and reopen the pack."
            onRetry={() => load(pack.id)}
            compact
          />
        )}

        {state.status === "ready" && (
          <ReadyBody
            payload={state.payload}
            tab={tab}
            onTabChange={setTab}
          />
        )}
      </div>
    </>
  );
}

function ReadyBody({
  payload,
  tab,
  onTabChange,
}: {
  payload: PackFullDetail;
  tab: ContentTab;
  onTabChange: (tab: ContentTab) => void;
}) {
  const { detail, stats } = payload;

  // KPI strip — derived from the maintained `packs.*` columns in `detail`,
  // exactly as the /packs/[id] page derives them (revenue = opens × price).
  const openings = detail.totalOpenings;
  const revenue = openings * detail.priceUsd;
  const payout = detail.totalPayout;
  const rtpPct = toPercent(detail.actualRtp);
  const houseEdgePct = 100 - rtpPct;

  return (
    <>
      {/* KPI strip — 2/4/8 across breakpoints, same as the page. */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4 lg:grid-cols-8">
        <KpiTile label="Price" value={formatCurrency(detail.priceUsd)} icon={DollarSign} accent="blue" />
        <KpiTile label="Openings" value={formatNumber(openings)} icon={Package} accent="cyan" />
        {/* Revenue = house gain (emerald), Payout = house loss (rose) — House-POV. */}
        <KpiTile label="Revenue" value={formatCurrency(revenue)} icon={TrendingUp} accent="emerald" />
        <KpiTile label="Payout" value={formatCurrency(payout)} icon={Coins} accent="rose" />
        <KpiTile label="RTP" value={`${rtpPct.toFixed(2)}%`} icon={Percent} accent={rtpPct > 100 ? "rose" : "purple"} />
        <KpiTile label="House Edge" value={`${houseEdgePct.toFixed(2)}%`} icon={TrendingUp} accent={houseEdgePct < 0 ? "rose" : "emerald"} />
        <KpiTile label="Cards/Open" value={String(detail.cardsPerOpen)} icon={Layers} accent="pink" />
        <KpiTile label="Total Cards" value={String(detail.cards.length)} icon={Boxes} accent="orange" />
      </div>

      {/* Chart stats — reuses the page's PackStatsSection. `stats` is null only
          when the two heavy scans timed out/failed server-side; degrade that
          block alone, exactly like the page's <PackStatsLazy> fallback. */}
      {stats ? (
        <PackStatsSection stats={stats} />
      ) : (
        <TileErrorFallback
          label="Pack stats"
          hint="The pack stats scan timed out or failed. Close this and reopen the pack to retry the charts."
          size="panel"
        />
      )}

      {/* Pack contents — Cards (already in hand) / Games (lazy on tab switch),
          reusing the exact list-page components. */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg border bg-muted/40">
            <Boxes className="size-4 text-muted-foreground" />
          </div>
          <h3 className="text-sm font-semibold tracking-tight">Pack Contents</h3>
        </div>

        {/* Local (non-URL) content-tab strip — same visual language as the
            page's PackContentTabsNav, but client-state driven so it lives
            entirely inside the modal. */}
        <div className="flex gap-1 rounded-lg border bg-muted/50 p-1">
          <ContentTabButton
            active={tab === "cards"}
            onClick={() => onTabChange("cards")}
            icon={Layers}
            label="Cards"
            count={detail.cards.length}
          />
          <ContentTabButton
            active={tab === "games"}
            onClick={() => onTabChange("games")}
            icon={Gamepad2}
            label="Games"
          />
        </div>

        {tab === "cards" ? (
          <PackCardsView cards={detail.cards} />
        ) : (
          // Heavy JSON-scan feed — only mounted (and only fetched) once the
          // Games tab is active, never on the default Cards view.
          <ModalGamesTab packId={detail.id} />
        )}
      </div>
    </>
  );
}

function ContentTabButton({
  active,
  onClick,
  icon: Icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Layers;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" />
      {label}
      {count != null && (
        <span className="text-xs text-muted-foreground">({count})</span>
      )}
    </button>
  );
}

/**
 * Lazily fetches the first page of the pack's games when the Games tab opens,
 * then hands the client <GamesTable> its `initialGames` (the same component the
 * full page uses; GamesTable then owns its own pagination/filter refetches).
 * Mirrors the page's GamesTabSection boundary — the scan runs on tab click, not
 * on modal open.
 */
function ModalGamesTab({ packId }: { packId: string }) {
  const [games, setGames] = React.useState<Awaited<
    ReturnType<typeof fetchPackGames>
  > | null>(null);
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">(
    "loading",
  );

  React.useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    fetchPackGames(packId, 1, 20)
      .then((res) => {
        if (cancelled) return;
        setGames(res);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [packId]);

  if (status === "loading") return <Skeleton className="h-96 rounded-xl" />;
  if (status === "error" || !games) {
    return (
      <TileErrorFallback
        label="Games"
        hint="The pack games feed timed out or failed. Switch tabs and back, or reopen the pack to retry."
        size="panel"
      />
    );
  }
  return <GamesTable packId={packId} initialGames={games} />;
}

function ModalBodySkeleton() {
  return (
    <div className="space-y-5">
      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4 lg:grid-cols-8">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-[68px] rounded-xl" />
        ))}
      </div>
      {/* Period card + two charts */}
      <Skeleton className="h-32 rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-[250px] rounded-xl" />
        <Skeleton className="h-[250px] rounded-xl" />
      </div>
      {/* Contents */}
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}
