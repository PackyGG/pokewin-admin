"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Boxes,
  Coins,
  Gamepad2,
  History,
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
import {
  KpiTile,
  PageHero,
  SectionHeading,
} from "@/components/modern-panels";
import { InlineError } from "@/components/entity-surface";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { toPercent } from "@/lib/house-pov";
import {
  computePackEconomics,
  PackEconomicsPanel,
} from "./pack-economics";
import { cn } from "@/lib/utils";
import { PackStatsSection } from "./[id]/revenue-chart";
import { PackCardsView, GamesTable } from "./[id]/pack-tabs";
import { TogglePackButton } from "./[id]/toggle-pack-button";
import { DeletePackButton } from "./[id]/delete-pack-button";
import { fetchPackDetailCore, type PackFullDetail } from "./actions";
import {
  invalidatePackDetailCache,
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

export function PackDetailView({
  packId,
  canToggle,
  canDelete,
  canEdit,
  canEditLive,
  isPackCreator,
  initialPayload = null,
}: {
  packId: string;
  canToggle: boolean;
  canDelete: boolean;
  canEdit: boolean;
  canEditLive: boolean;
  isPackCreator: boolean;
  /**
   * Server-prefetched full detail. When present the view paints ready
   * immediately and skips the initial client fetch (no hydrate→action
   * waterfall). Null falls back to the client load()/retry flow.
   */
  initialPayload?: PackFullDetail | null;
}) {
  const router = useRouter();
  const [state, setState] = React.useState<DetailState>(
    initialPayload
      ? { status: "ready", payload: initialPayload }
      : { status: "loading" },
  );
  const [tab, setTab] = React.useState<ContentTab>("cards");
  const [viewMode, setViewMode] = React.useState<ViewMode>("overview");
  const [statsRetrying, setStatsRetrying] = React.useState(false);

  const load = React.useCallback(
    (force = false) => {
      let cancelled = false;
      setState({ status: "loading" });
      // Load the CORE detail only (identity + economics + card pool) and paint
      // ready immediately with `stats: null`. The heavy chart stats — two
      // `getPackStats` scans over provably_fair_results — are NOT awaited here:
      // the `statsAutoLoadedFor` effect below streams them in behind their own
      // skeleton once detail is ready. Awaiting both up front (the old
      // `loadPackFullDetail` path) forced BOTH the detail read AND the double
      // PF-scan to finish before anything rendered, so opening the pack ran the
      // heavy double scan blocking first paint. `force` is unused now (stats
      // caching is handled per-fetch by `loadPackStats`); kept for signature
      // stability with the retry/toggle callers.
      void force;
      fetchPackDetailCore(packId)
        .then((detail) => {
          if (cancelled) return;
          if (!detail) {
            setState({ status: "notfound" });
            return;
          }
          setState({ status: "ready", payload: { detail, stats: null } });
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
    setViewMode("overview");
    // Server-prefetched payload (incl. after a pack→pack navigation that
    // re-runs the server page): paint it directly, skip the client fetch.
    if (initialPayload) {
      setState({ status: "ready", payload: initialPayload });
      return;
    }
    return load(false);
  }, [packId, load, initialPayload]);

  // NOTE: there is deliberately no second "header seed" lookup here. This view
  // is mounted only by /packs/[id], where `initialPayload` is always null, so a
  // seed fetch ran on EVERY pack open — concurrently with `fetchPackDetailCore`
  // and returning a strict SUBSET of the same row (id/name/slug/image/active/
  // price). Under the process-wide mirror admission cap total reads per render
  // is what costs, and that one was pure duplication; worse, it was the only
  // read in this surface issued against the PRIMARY MAIN pool (max 3,
  // shared with every mutation flow) instead of the read mirror. Removed: the
  // hero identity now comes from the single core-detail read, and the loading
  // state below is rendered honestly while it is in flight.
  const detail = state.status === "ready" ? state.payload.detail : null;

  const title = detail?.name ?? "Pack";
  const imageUrl = detail?.imageUrl ?? null;
  const active = detail?.active ?? false;
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

  // The server now prefetches only the core detail (stats === null) so the
  // page paints fast. Auto-load the heavy stats ONCE per pack here so the
  // stats section streams in behind a skeleton instead of blocking first
  // paint. A genuine failure (loadPackStats resolves null) leaves stats null
  // and — since the ref guard already fired — surfaces the manual retry tile.
  const statsAutoLoadedFor = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (state.status !== "ready") return;
    if (state.payload.stats !== null) return;
    if (statsAutoLoadedFor.current === packId) return;
    statsAutoLoadedFor.current = packId;
    setStatsRetrying(true);
    loadPackStats(packId, state.payload.detail)
      .then((nextStats) => {
        setState((prev) =>
          prev.status === "ready"
            ? { status: "ready", payload: { ...prev.payload, stats: nextStats } }
            : prev,
        );
      })
      .catch(() => {})
      .finally(() => setStatsRetrying(false));
  }, [state, packId]);

  async function retryStats() {
    if (!detail || statsRetrying) return;
    setStatsRetrying(true);
    try {
      // Re-run ONLY the stats scans (force-bust the per-fetch stats cache) and
      // splice them into the already-rendered detail. We never re-fetch the
      // core detail here — it's already in state — so a stats retry can't
      // re-trigger the detail read, and there's no full double-fetch round-trip.
      const nextStats = await loadPackStats(packId, detail, { force: true });
      setState((prev) =>
        prev.status === "ready"
          ? { status: "ready", payload: { ...prev.payload, stats: nextStats } }
          : prev,
      );
      // Drop any stale modal-cache payload for this pack so a later reopen
      // re-fetches fresh stats instead of serving the timed-out null.
      if (nextStats) invalidatePackDetailCache(packId);
    } finally {
      setStatsRetrying(false);
    }
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
        <div className="rounded-xl border bg-card/40 p-4 shadow-sm sm:p-5">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <div className="shrink-0 overflow-hidden rounded-xl border bg-muted/40 shadow-sm">
              <CardImage src={imageUrl} alt={title} className="size-16 object-cover sm:size-20" />
            </div>
            <div className="min-w-0 flex-1">
              {loading ? (
                <Skeleton className="h-7 w-48" />
              ) : (
                <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">
                  {title}
                </h1>
              )}
              {detail?.slug ? (
                <p className="mt-1 truncate text-sm text-muted-foreground">/{detail.slug}</p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {loading ? (
                  <Skeleton className="h-5 w-16 rounded-full" />
                ) : (
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
                )}
                {packType ? (
                  <Badge variant="outline" className="capitalize">
                    {packType}
                  </Badge>
                ) : null}
              </div>
            </div>

            {showActions && detail ? (
              <div className="flex shrink-0 flex-wrap items-center gap-2 sm:self-start">
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
                    onDeleted={() => router.push("/packs")}
                  />
                ) : null}
              </div>
            ) : viewMode === "edit" ? (
              <Button size="sm" variant="outline" onClick={() => setViewMode("overview")}>
                Back to overview
              </Button>
            ) : null}
          </div>
        </div>
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
  const realizedRtpPct = toPercent(detail.actualRtp);
  const realizedEdgePct = 100 - realizedRtpPct;
  const econ = computePackEconomics({
    priceUsd: detail.priceUsd,
    cardsPerOpen: detail.cardsPerOpen,
    packType: detail.packType,
    pool: detail.cards.map((c) => ({ weight: c.weight, priceUsd: c.priceUsd })),
  });

  return (
    <>
      <PackEconomicsPanel econ={econ} />

      <section className="space-y-3">
        <SectionHeading icon={History} title="Lifetime performance" />
        <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
          <KpiTile label="Openings" value={formatNumber(openings)} icon={Package} accent="cyan" />
          <KpiTile label="Revenue" value={formatCurrency(revenue)} icon={TrendingUp} accent="emerald" sub="Wagered into this pack" />
          <KpiTile label="Payout" value={formatCurrency(payout)} icon={Coins} accent="rose" sub="Card value handed out" />
          <KpiTile
            label="Realized edge"
            value={openings > 0 ? `${realizedEdgePct.toFixed(2)}%` : "—"}
            icon={Percent}
            accent={realizedEdgePct < 0 ? "rose" : "emerald"}
            sub={openings > 0 ? `RTP ${realizedRtpPct.toFixed(2)}%` : "No opens yet"}
          />
        </div>
      </section>

      {stats ? (
        <PackStatsSection stats={stats} />
      ) : statsRetrying ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <Skeleton className="h-[250px] rounded-xl" />
          <Skeleton className="h-[250px] rounded-xl" />
        </div>
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

      <section className="space-y-3">
        <SectionHeading
          icon={Boxes}
          title="Pack contents"
          action={
            <div className="flex gap-1 rounded-lg border bg-muted/50 p-1">
              <ContentTabButton active={tab === "cards"} onClick={() => onTabChange("cards")} icon={Layers} label="Cards" count={detail.cards.length} />
              <ContentTabButton active={tab === "games"} onClick={() => onTabChange("games")} icon={Gamepad2} label="Games" />
            </div>
          }
        />

        {tab === "cards" ? (
          <PackCardsView cards={detail.cards} />
        ) : (
          <GamesTab packId={detail.id} />
        )}
      </section>
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
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[92px] rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[68px] rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-[68px] rounded-xl" />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-[250px] rounded-xl" />
        <Skeleton className="h-[250px] rounded-xl" />
      </div>
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}
