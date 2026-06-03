"use client";

import * as React from "react";
import { Package } from "lucide-react";
import {
  ActiveBadge,
  InspectorSheet,
  InlineError,
  RarityDot,
} from "@/components/entity-surface";
import { CardImage } from "@/components/card-image";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { houseAmountTextClass, toPercent } from "@/lib/house-pov";
import { cn } from "@/lib/utils";
import type { PackListItem, PackInspectorData } from "@/lib/queries/packs";
import { fetchPackInspector } from "./actions";

/**
 * Side-sheet preview for a pack opened from a list row. A FAST preview — it
 * lazy-fetches a lightweight summary (identity + economics + top-of-pool card
 * preview) the moment the sheet opens, so the operator can eyeball a pack's
 * health and its likeliest pulls without leaving the list. The full card pool,
 * charts and games feed stay on the deep-linked /packs/[id] page (the header's
 * "Open full page" button).
 *
 * Seeded with the row's already-known fields (name/art/economics) so the
 * header + KPI strip paint instantly from props; the deferred body fetches
 * only the extra detail (description + card preview) the row didn't carry.
 */
export function PackInspector({
  pack,
  open,
  onOpenChange,
}: {
  /** The row's list item (instant header/KPIs); null when nothing selected. */
  pack: PackListItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <InspectorSheet
      open={open}
      onOpenChange={onOpenChange}
      icon={Package}
      accent="blue"
      title={pack?.name ?? "Pack"}
      subtitle={pack?.slug}
      fullHref={pack ? `/packs/${pack.id}` : undefined}
      bodyMinHeight={320}
    >
      {pack && <InspectorBody pack={pack} />}
    </InspectorSheet>
  );
}

function InspectorBody({ pack }: { pack: PackListItem }) {
  // Fetch runs only because LazyModalContent mounted this body (sheet open).
  const [data, setData] = React.useState<PackInspectorData | null>(null);
  const [state, setState] = React.useState<"loading" | "ready" | "error">(
    "loading",
  );

  const load = React.useCallback(() => {
    let cancelled = false;
    setState("loading");
    fetchPackInspector(pack.id)
      .then((res) => {
        if (cancelled) return;
        setData(res);
        setState("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [pack.id]);

  React.useEffect(() => load(), [load]);

  // KPI strip reads from the row's known fields immediately; the deferred
  // fetch only enriches the card preview + description below.
  const edgePct = toPercent(pack.actualHouseEdge);
  const rtpPct = toPercent(pack.actualRtp);

  return (
    <div className="space-y-5">
      {/* Identity row */}
      <div className="flex items-start gap-3">
        <div className="shrink-0 overflow-hidden rounded-xl border bg-muted/40 ring-1 ring-inset ring-white/5">
          <CardImage
            src={pack.imageUrl}
            alt={pack.name}
            className="size-14 object-cover"
          />
        </div>
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <ActiveBadge active={pack.active} />
            <span className="text-base font-bold tabular-nums">
              {formatCurrency(pack.priceUsd)}
            </span>
          </div>
          {state === "ready" && data?.description ? (
            <p className="mt-1.5 line-clamp-3 text-xs text-muted-foreground">
              {data.description}
            </p>
          ) : state === "loading" ? (
            <Skeleton className="mt-2 h-3 w-3/4 rounded" />
          ) : null}
        </div>
      </div>

      {/* Economics KPI grid — House-POV colors on edge / payout. */}
      <div className="grid grid-cols-2 gap-2">
        <InspectorStat label="Opens" value={formatNumber(pack.totalOpenings)} />
        <InspectorStat
          label="Revenue"
          value={formatCurrency(pack.totalRevenue)}
          valueClass="text-emerald-600 dark:text-emerald-400"
        />
        <InspectorStat
          label="Payout"
          value={formatCurrency(pack.totalPayout)}
          valueClass="text-rose-600 dark:text-rose-400"
        />
        <InspectorStat
          label="House Edge"
          value={`${edgePct.toFixed(1)}%`}
          valueClass={houseAmountTextClass(pack.actualHouseEdge)}
        />
        <InspectorStat label="RTP" value={`${rtpPct.toFixed(1)}%`} />
        <InspectorStat
          label="Cards / open"
          value={formatNumber(pack.cardsPerOpen)}
        />
      </div>

      {/* Top-of-pool card preview (deferred fetch). */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Likeliest pulls
          </h4>
          {state === "ready" && data && (
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {formatNumber(data.totalCardCount)} cards
            </span>
          )}
        </div>

        {state === "loading" && (
          <div className="space-y-1.5">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-lg" />
            ))}
          </div>
        )}

        {state === "error" && (
          <InlineError
            compact
            title="Couldn't load the card preview"
            hint="The pool preview failed to load. Open the full page for the complete pool."
            onRetry={load}
          />
        )}

        {state === "ready" && data && data.topCards.length === 0 && (
          <p className="rounded-lg border border-dashed bg-card/30 px-3 py-6 text-center text-xs text-muted-foreground">
            This pack has no cards yet.
          </p>
        )}

        {state === "ready" && data && data.topCards.length > 0 && (
          <ul className="space-y-1.5">
            {data.topCards.map((card) => (
              <li
                key={card.cardId}
                className="flex items-center gap-2.5 rounded-lg border bg-card/40 px-2 py-1.5"
              >
                <CardImage
                  src={card.imageUrl}
                  alt={card.name}
                  className="size-8 shrink-0 rounded-md ring-1 ring-border"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <RarityDot rarity={card.rarity} />
                    <span className="truncate text-xs font-medium" title={card.name}>
                      {card.name}
                    </span>
                  </div>
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {formatCurrency(card.priceUsd)}
                  </span>
                </div>
                <span className="shrink-0 text-xs font-semibold tabular-nums">
                  {card.probability.toFixed(card.probability < 1 ? 2 : 1)}%
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function InspectorStat({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border bg-card/40 px-2.5 py-2">
      <p className="truncate text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <p className={cn("mt-0.5 truncate text-sm font-semibold tabular-nums", valueClass)}>
        {value}
      </p>
    </div>
  );
}
