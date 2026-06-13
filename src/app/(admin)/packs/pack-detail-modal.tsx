"use client";

import * as React from "react";
import {
  Boxes,
  Coins,
  DollarSign,
  Gamepad2,
  Layers,
  Package,
  Pencil,
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
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CardImage } from "@/components/card-image";
import { KpiTile } from "@/components/modern-panels";
import { InlineError } from "@/components/entity-surface";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { toPercent } from "@/lib/house-pov";
import { cn } from "@/lib/utils";
import { PackStatsSection } from "./[id]/revenue-chart";
import { PackCardsView, GamesTable } from "./[id]/pack-tabs";
import { TogglePackButton } from "./[id]/toggle-pack-button";
import { DeletePackButton } from "./[id]/delete-pack-button";
import { fetchPackListSeed, type PackFullDetail } from "./actions";
import type { PackInspectSeed } from "./pack-inspect-context";
import {
  invalidatePackDetailCache,
  loadPackFullDetail,
  loadPackGamesPage,
  loadPackStats,
} from "./pack-detail-cache";
import { PackEditForm } from "./pack-edit-form";

type ModalState =
  | { status: "loading" }
  | { status: "ready"; payload: PackFullDetail }
  | { status: "notfound" }
  | { status: "error" };

type ContentTab = "cards" | "games";
type ViewMode = "overview" | "edit";

export function PackDetailModal({
  packId,
  seed,
  open,
  onOpenChange,
  canToggle,
  canDelete,
  canEdit,
  canEditLive,
  isPackCreator,
}: {
  packId: string | null;
  seed: PackInspectSeed | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canToggle: boolean;
  canDelete: boolean;
  canEdit: boolean;
  canEditLive: boolean;
  isPackCreator: boolean;
}) {
  if (!packId) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-5xl lg:max-w-6xl sm:w-[calc(100%-3rem)] sm:max-h-[90vh] gap-0 p-0"
        showCloseButton
      >
        <ModalInner
          key={packId}
          packId={packId}
          seed={seed}
          open={open}
          canToggle={canToggle}
          canDelete={canDelete}
          canEdit={canEdit}
          canEditLive={canEditLive}
          isPackCreator={isPackCreator}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function ModalInner({
  packId,
  seed,
  open,
  canToggle,
  canDelete,
  canEdit,
  canEditLive,
  isPackCreator,
  onClose,
}: {
  packId: string;
  seed: PackInspectSeed | null;
  open: boolean;
  canToggle: boolean;
  canDelete: boolean;
  canEdit: boolean;
  canEditLive: boolean;
  isPackCreator: boolean;
  onClose: () => void;
}) {
  const [headerSeed, setHeaderSeed] = React.useState<PackInspectSeed | null>(seed);
  const [state, setState] = React.useState<ModalState>({ status: "loading" });
  const [tab, setTab] = React.useState<ContentTab>("cards");
  const [viewMode, setViewMode] = React.useState<ViewMode>("overview");
  const [statsRetrying, setStatsRetrying] = React.useState(false);

  React.useEffect(() => {
    if (seed) setHeaderSeed(seed);
  }, [seed]);

  const load = React.useCallback(
    (force = false) => {
      let cancelled = false;
      setState({ status: "loading" });
      loadPackFullDetail(packId, { force })
        .then((res) => {
          if (cancelled) return;
          if (!res) {
            setState({ status: "notfound" });
            return;
          }
          setHeaderSeed({
            id: res.detail.id,
            name: res.detail.name,
            slug: res.detail.slug,
            imageUrl: res.detail.imageUrl,
            active: res.detail.active,
            priceUsd: res.detail.priceUsd,
          });
          setState({ status: "ready", payload: res });
        })
        .catch(() => {
          if (!cancelled) setState({ status: "error" });
        });
      return () => {
        cancelled = true;
      };
    },
    [packId],
  );

  React.useEffect(() => {
    if (!open) return;
    setTab("cards");
    setViewMode("overview");
    return load(false);
  }, [open, packId, load]);

  // Deep-link fallback: fetch lightweight seed when pack isn't on current page.
  React.useEffect(() => {
    if (!open || headerSeed?.name !== "Loading…") return;
    let cancelled = false;
    fetchPackListSeed(packId)
      .then((s) => {
        if (cancelled || !s) return;
        setHeaderSeed({
          id: s.id,
          name: s.name,
          slug: s.slug,
          imageUrl: s.imageUrl,
          active: s.active,
          priceUsd: s.priceUsd,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, packId, headerSeed?.name]);

  const detail = state.status === "ready" ? state.payload.detail : null;
  const stats = state.status === "ready" ? state.payload.stats : null;

  const title = detail?.name ?? headerSeed?.name ?? "Pack";
  const slug = detail?.slug ?? headerSeed?.slug ?? "";
  const imageUrl = detail?.imageUrl ?? headerSeed?.imageUrl ?? null;
  const active = detail?.active ?? headerSeed?.active ?? false;
  const packType = detail?.packType ?? null;
  const loading = state.status === "loading";

  const showEditButton =
    canEdit &&
    detail != null &&
    (!isPackCreator || !detail.active || canEditLive);

  const showActions =
    !loading &&
    viewMode === "overview" &&
    detail != null &&
    (showEditButton || canToggle || canDelete);

  async function retryStats() {
    if (!detail || statsRetrying) return;
    setStatsRetrying(true);
    try {
      const nextStats = await loadPackStats(packId, detail, { force: true });
      setState((prev) =>
        prev.status === "ready"
          ? { status: "ready", payload: { ...prev.payload, stats: nextStats } }
          : prev,
      );
      if (nextStats) {
        invalidatePackDetailCache(packId);
        const cached = await loadPackFullDetail(packId, { force: true });
        if (cached) setState({ status: "ready", payload: cached });
      }
    } finally {
      setStatsRetrying(false);
    }
  }

  return (
    <>
      <DialogHeader className="sticky top-0 z-10 border-b bg-background/95 px-4 py-4 backdrop-blur-sm supports-backdrop-filter:bg-background/80 sm:px-6">
        <div className="flex items-start gap-3 pr-10 sm:gap-4">
          <div className="shrink-0 overflow-hidden rounded-xl border bg-muted/40 shadow-sm">
            <CardImage src={imageUrl} alt={title} className="size-14 object-cover sm:size-16" />
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
                    ? "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "border-zinc-500/30 bg-zinc-500/15 text-zinc-600 dark:text-zinc-400"
                }
              >
                {active ? "Active" : "Inactive"}
              </Badge>
              {packType ? (
                <Badge variant="outline" className="capitalize">
                  {packType}
                </Badge>
              ) : null}
              <DialogDescription render={<span />} className="font-mono text-xs text-muted-foreground">
                {slug}
              </DialogDescription>
            </div>
          </div>
        </div>

        {showActions && detail ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 sm:gap-2">
            {showEditButton ? (
              <Button size="sm" variant="outline" onClick={() => setViewMode("edit")}>
                <Pencil className="mr-1 size-3.5" />
                Edit
              </Button>
            ) : null}
            {canToggle ? (
              <TogglePackButton
                packId={detail.id}
                active={detail.active}
                onToggled={() => load(true)}
              />
            ) : null}
            {canDelete ? (
              <DeletePackButton
                packId={detail.id}
                packName={detail.name}
                onDeleted={onClose}
              />
            ) : null}
          </div>
        ) : null}

        {viewMode === "edit" ? (
          <div className="mt-3">
            <Button size="sm" variant="ghost" onClick={() => setViewMode("overview")}>
              ← Back to overview
            </Button>
          </div>
        ) : null}
      </DialogHeader>

      <div className="space-y-5 px-4 py-5 sm:px-6">
        {loading && <ModalBodySkeleton />}

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
            hint="The pack detail timed out or failed. Retry, or close and reopen."
            onRetry={() => load(true)}
            compact
          />
        )}

        {viewMode === "edit" && detail ? (
          <PackEditForm
            key={detail.id}
            pack={detail}
            onCancel={() => setViewMode("overview")}
            onSaved={() => {
              setViewMode("overview");
              load(true);
            }}
          />
        ) : null}

        {viewMode === "overview" && state.status === "ready" ? (
          <ReadyBody
            payload={state.payload}
            tab={tab}
            onTabChange={setTab}
            onRetryStats={retryStats}
            statsRetrying={statsRetrying}
          />
        ) : null}
      </div>
    </>
  );
}

function ReadyBody({
  payload,
  tab,
  onTabChange,
  onRetryStats,
  statsRetrying,
}: {
  payload: PackFullDetail;
  tab: ContentTab;
  onTabChange: (tab: ContentTab) => void;
  onRetryStats: () => void;
  statsRetrying: boolean;
}) {
  const { detail, stats } = payload;
  const openings = detail.totalOpenings;
  const revenue = openings * detail.priceUsd;
  const payout = detail.totalPayout;
  const rtpPct = toPercent(detail.actualRtp);
  const houseEdgePct = 100 - rtpPct;

  return (
    <>
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4 lg:grid-cols-8">
        <KpiTile label="Price" value={formatCurrency(detail.priceUsd)} icon={DollarSign} accent="blue" />
        <KpiTile label="Openings" value={formatNumber(openings)} icon={Package} accent="cyan" />
        <KpiTile label="Revenue" value={formatCurrency(revenue)} icon={TrendingUp} accent="emerald" />
        <KpiTile label="Payout" value={formatCurrency(payout)} icon={Coins} accent="rose" />
        <KpiTile label="RTP" value={`${rtpPct.toFixed(2)}%`} icon={Percent} accent={rtpPct > 100 ? "rose" : "purple"} />
        <KpiTile label="House Edge" value={`${houseEdgePct.toFixed(2)}%`} icon={TrendingUp} accent={houseEdgePct < 0 ? "rose" : "emerald"} />
        <KpiTile label="Cards/Open" value={String(detail.cardsPerOpen)} icon={Layers} accent="pink" />
        <KpiTile label="Total Cards" value={String(detail.cards.length)} icon={Boxes} accent="orange" />
      </div>

      {stats ? (
        <PackStatsSection stats={stats} />
      ) : (
        <div className="space-y-2">
          <TileErrorFallback
            label="Pack stats"
            hint="The pack stats scan timed out or failed."
            size="panel"
          />
          <Button size="sm" variant="outline" onClick={onRetryStats} disabled={statsRetrying}>
            {statsRetrying ? "Retrying…" : "Retry stats"}
          </Button>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-lg border bg-muted/40">
            <Boxes className="size-4 text-muted-foreground" />
          </div>
          <h3 className="text-sm font-semibold tracking-tight">Pack Contents</h3>
        </div>

        <div className="flex gap-1 rounded-lg border bg-muted/50 p-1">
          <ContentTabButton active={tab === "cards"} onClick={() => onTabChange("cards")} icon={Layers} label="Cards" count={detail.cards.length} />
          <ContentTabButton active={tab === "games"} onClick={() => onTabChange("games")} icon={Gamepad2} label="Games" />
        </div>

        {tab === "cards" ? (
          <PackCardsView cards={detail.cards} />
        ) : (
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
        active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" />
      {label}
      {count != null ? <span className="text-xs text-muted-foreground">({count})</span> : null}
    </button>
  );
}

function ModalGamesTab({ packId }: { packId: string }) {
  const [games, setGames] = React.useState<Awaited<ReturnType<typeof loadPackGamesPage>> | null>(null);
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");

  React.useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    loadPackGamesPage(packId)
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
      <div className="space-y-2">
        <TileErrorFallback
          label="Games"
          hint="The pack games feed timed out or failed."
          size="panel"
        />
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setStatus("loading");
            loadPackGamesPage(packId, { force: true })
              .then((res) => {
                setGames(res);
                setStatus("ready");
              })
              .catch(() => setStatus("error"));
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
  return <GamesTable packId={packId} initialGames={games} />;
}

function ModalBodySkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 md:grid-cols-4 lg:grid-cols-8">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-[68px] rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-32 rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-[250px] rounded-xl" />
        <Skeleton className="h-[250px] rounded-xl" />
      </div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}
