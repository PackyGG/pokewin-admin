"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CardImage } from "@/components/card-image";
import { KpiTile, PageHero, PageHeroIdentity } from "@/components/modern-panels";
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
import {
  invalidatePackDetailCache,
  loadPackFullDetail,
  loadPackGamesPage,
  loadPackStats,
} from "./pack-detail-cache";
import { PackEditForm } from "./pack-edit-form";

type DetailState =
  | { status: "loading" }
  | { status: "ready"; payload: PackFullDetail }
  | { status: "notfound" }
  | { status: "error" };

type ContentTab = "cards" | "games";
type ViewMode = "overview" | "edit";

type HeaderSeed = {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  active: boolean;
  priceUsd: number;
};

export function PackDetailView({
  packId,
  canToggle,
  canDelete,
  canEdit,
  canEditLive,
  isPackCreator,
  initialViewMode = "overview",
}: {
  packId: string;
  canToggle: boolean;
  canDelete: boolean;
  canEdit: boolean;
  canEditLive: boolean;
  isPackCreator: boolean;
  initialViewMode?: ViewMode;
}) {
  const router = useRouter();
  const [headerSeed, setHeaderSeed] = React.useState<HeaderSeed | null>(null);
  const [state, setState] = React.useState<DetailState>({ status: "loading" });
  const [tab, setTab] = React.useState<ContentTab>("cards");
  const [viewMode, setViewMode] = React.useState<ViewMode>(initialViewMode);
  const [statsRetrying, setStatsRetrying] = React.useState(false);

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
    setTab("cards");
    setViewMode(initialViewMode);
    return load(false);
  }, [packId, initialViewMode, load]);

  React.useEffect(() => {
    if (headerSeed?.name !== "Loading…") return;
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
  }, [packId, headerSeed?.name]);

  React.useEffect(() => {
    if (headerSeed) return;
    setHeaderSeed({
      id: packId,
      name: "Loading…",
      slug: "",
      imageUrl: null,
      active: false,
      priceUsd: 0,
    });
  }, [packId, headerSeed]);

  const detail = state.status === "ready" ? state.payload.detail : null;

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

  function enterEditMode() {
    setViewMode("edit");
    router.replace(`/packs/${packId}?edit=1`, { scroll: false });
  }

  function exitEditMode() {
    setViewMode("overview");
    router.replace(`/packs/${packId}`, { scroll: false });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Link
          href="/packs"
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" />
          Packs
        </Link>
      </div>

      <PageHero>
        <PageHeroIdentity
          icon={Package}
          title={title}
          subtitle={slug || "Pack detail"}
          action={
            showActions && detail ? (
              <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
                {showEditButton ? (
                  <Button size="sm" variant="outline" onClick={enterEditMode}>
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
                    onDeleted={() => router.push("/packs")}
                  />
                ) : null}
              </div>
            ) : undefined
          }
        />
        <div className="mt-4 flex items-start gap-3 sm:gap-4">
          <div className="shrink-0 overflow-hidden rounded-xl border bg-muted/40 shadow-sm">
            <CardImage src={imageUrl} alt={title} className="size-16 object-cover sm:size-20" />
          </div>
          <div className="min-w-0 flex-1 pt-0.5">
            <div className="flex flex-wrap items-center gap-1.5">
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
            </div>
          </div>
        </div>
        {viewMode === "edit" ? (
          <div className="mt-3">
            <Button size="sm" variant="ghost" onClick={exitEditMode}>
              ← Back to overview
            </Button>
          </div>
        ) : null}
      </PageHero>

      <div className="space-y-5">
        {loading && <DetailBodySkeleton />}

        {state.status === "notfound" && (
          <InlineError
            title="Pack not found"
            hint="This pack may have been deleted. Return to the catalog and refresh."
            compact
          />
        )}

        {state.status === "error" && (
          <InlineError
            title="Couldn't load this pack"
            hint="The pack detail timed out or failed. Retry, or go back to the catalog."
            onRetry={() => load(true)}
            compact
          />
        )}

        {viewMode === "edit" && detail ? (
          <PackEditForm
            key={detail.id}
            pack={detail}
            onCancel={exitEditMode}
            onSaved={() => {
              exitEditMode();
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
    </div>
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
          <GamesTab packId={detail.id} />
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

function GamesTab({ packId }: { packId: string }) {
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

function DetailBodySkeleton() {
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
