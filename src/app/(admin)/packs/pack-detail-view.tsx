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
  PageHeroIdentity,
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
import {
  fetchPackDetailCore,
  fetchPackListSeed,
  type PackFullDetail,
} from "./actions";
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

type HeaderSeed = {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  active: boolean;
  priceUsd: number;
};

function seedFromPayload(payload: PackFullDetail): HeaderSeed {
  return {
    id: payload.detail.id,
    name: payload.detail.name,
    slug: payload.detail.slug,
    imageUrl: payload.detail.imageUrl,
    active: payload.detail.active,
    priceUsd: payload.detail.priceUsd,
  };
}

export function PackDetailView({
  packId,
  canToggle,
  canDelete,
  canEdit,
  canEditLive,
  isPackCreator,
  initialViewMode = "overview",
  initialPayload = null,
}: {
  packId: string;
  canToggle: boolean;
  canDelete: boolean;
  canEdit: boolean;
  canEditLive: boolean;
  isPackCreator: boolean;
  initialViewMode?: ViewMode;
  /**
   * Server-prefetched full detail. When present the view paints ready
   * immediately and skips the initial client fetch (no hydrate→action
   * waterfall). Null falls back to the client load()/retry flow.
   */
  initialPayload?: PackFullDetail | null;
}) {
  const router = useRouter();
  const [headerSeed, setHeaderSeed] = React.useState<HeaderSeed | null>(
    initialPayload ? seedFromPayload(initialPayload) : null,
  );
  const [state, setState] = React.useState<DetailState>(
    initialPayload
      ? { status: "ready", payload: initialPayload }
      : { status: "loading" },
  );
  const [tab, setTab] = React.useState<ContentTab>("cards");
  const [viewMode, setViewMode] = React.useState<ViewMode>(initialViewMode);
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
          setHeaderSeed({
            id: detail.id,
            name: detail.name,
            slug: detail.slug,
            imageUrl: detail.imageUrl,
            active: detail.active,
            priceUsd: detail.priceUsd,
          });
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
    setViewMode(initialViewMode);
    // Server-prefetched payload (incl. after a pack→pack navigation that
    // re-runs the server page): paint it directly, skip the client fetch.
    if (initialPayload) {
      setHeaderSeed(seedFromPayload(initialPayload));
      setState({ status: "ready", payload: initialPayload });
      return;
    }
    return load(false);
  }, [packId, initialViewMode, load, initialPayload]);

  // Seed the header identity from the lightweight list-seed lookup while the
  // heavy detail streams in — but ONLY while there's no already-seeded header
  // (and no resolved detail, which sets the seed via `load()`). The effect
  // re-runs only when `packId` or `headerSeed` changes, so once a seed exists
  // the `if (headerSeed) return` guard blocks any refetch; there's no
  // string-name sentinel that could leak "Loading…" into the hero title — while
  // the name is unknown the title renders a <Skeleton>.
  React.useEffect(() => {
    if (headerSeed) return;
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
  }, [packId, headerSeed]);

  const detail = state.status === "ready" ? state.payload.detail : null;

  const resolvedName = detail?.name ?? headerSeed?.name ?? null;
  const title = resolvedName ?? "Pack";
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

  function enterEditMode() {
    setViewMode("edit");
    router.replace(`/packs/${packId}?edit=1`, { scroll: false });
  }

  function exitEditMode() {
    setViewMode("overview");
    // Pass edit=0 explicitly: the detail page now defaults to edit mode for
    // editors, so a bare /packs/:id would re-open the editor. edit=0 pins
    // the overview when the user steps back out of the form.
    router.replace(`/packs/${packId}?edit=0`, { scroll: false });
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
