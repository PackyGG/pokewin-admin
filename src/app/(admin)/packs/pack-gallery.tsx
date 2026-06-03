"use client";

import * as React from "react";
import { Package } from "lucide-react";
import { CardImage } from "@/components/card-image";
import { EmptyState, ActiveBadge } from "@/components/entity-surface";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { houseAmountTextClass, toPercent } from "@/lib/house-pov";
import { cn } from "@/lib/utils";
import type { PackListItem } from "@/lib/queries/packs";
import { PackRowActions } from "./pack-row-actions";

/**
 * Secondary "Gallery" view for /packs — the art-browse view, one click from
 * the dense triage table (the default). Kept so the catalog's visual browse
 * isn't lost in the rebuild, but no longer the primary IA: economic triage
 * lives in the table.
 *
 * Tiles now open the shared INSPECTOR (same as a table row click) instead of
 * hard-navigating, so a quick look never loses list context; the kebab carries
 * the identical action surface as the table (quick-edit / open / toggle /
 * delete). House-POV colors are applied uniformly to edge AND RTP AND payout
 * (the old tile only colored edge).
 */
export function PackGallery({
  data,
  canToggle,
  canDelete,
  canQuickEdit,
  onOpenInspector,
  onQuickEdit,
  activeId,
}: {
  data: PackListItem[];
  canToggle: boolean;
  canDelete: boolean;
  canQuickEdit: boolean;
  onOpenInspector: (pack: PackListItem) => void;
  onQuickEdit: (pack: PackListItem) => void;
  activeId: string | null;
}) {
  if (data.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed bg-card/30">
        <EmptyState
          icon={Package}
          title="No packs match your filters"
          description="Try a different search or status filter."
        />
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {data.map((pack) => (
        <PackTile
          key={pack.id}
          pack={pack}
          canToggle={canToggle}
          canDelete={canDelete}
          canQuickEdit={canQuickEdit}
          onOpenInspector={onOpenInspector}
          onQuickEdit={onQuickEdit}
          isActive={activeId === pack.id}
        />
      ))}
    </div>
  );
}

function PackTile({
  pack,
  canToggle,
  canDelete,
  canQuickEdit,
  onOpenInspector,
  onQuickEdit,
  isActive,
}: {
  pack: PackListItem;
  canToggle: boolean;
  canDelete: boolean;
  canQuickEdit: boolean;
  onOpenInspector: (pack: PackListItem) => void;
  onQuickEdit: (pack: PackListItem) => void;
  isActive: boolean;
}) {
  const showActions = canToggle || canDelete || canQuickEdit;

  function handleClick(e: React.MouseEvent) {
    // Ignore clicks that originated on a control (kebab, menu) so the tile's
    // inspector-open never fights the action menu.
    const el = e.target as HTMLElement;
    if (el.closest("button, a, [role=menu], [data-no-row-click]")) return;
    onOpenInspector(pack);
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpenInspector(pack);
        }
      }}
      className={cn(
        "group relative cursor-pointer overflow-hidden rounded-xl border bg-card/50 text-left outline-none",
        "transition-all duration-200 focus-visible:ring-2 focus-visible:ring-ring/50",
        "motion-safe:hover:-translate-y-0.5 hover:border-primary/40 hover:bg-card hover:shadow-md",
        isActive && "border-primary/50 bg-accent/30 ring-1 ring-primary/30",
        !pack.active && "opacity-80",
      )}
    >
      {showActions && (
        <div className="absolute right-2 top-2 z-10 opacity-0 transition-opacity motion-safe:duration-150 group-hover:opacity-100 focus-within:opacity-100">
          <PackRowActions
            pack={pack}
            canToggle={canToggle}
            canDelete={canDelete}
            canQuickEdit={canQuickEdit}
            onQuickEdit={onQuickEdit}
          />
        </div>
      )}

      {/* Header: image + name/price + status */}
      <div className="flex items-start gap-3 p-3 pr-10">
        <div className="relative shrink-0">
          <CardImage
            src={pack.imageUrl}
            alt={pack.name}
            className="size-12 rounded-lg ring-1 ring-border"
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3
              className="line-clamp-2 text-sm font-semibold leading-tight transition-colors group-hover:text-primary"
              title={pack.name}
            >
              {pack.name}
            </h3>
            <span className="shrink-0 rounded-md border bg-background/60 px-1.5 py-0.5 text-xs font-semibold tabular-nums">
              {formatCurrency(pack.priceUsd)}
            </span>
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            <ActiveBadge active={pack.active} size="sm" />
            <p className="truncate text-[11px] text-muted-foreground">
              {formatNumber(pack.totalOpenings)} opens · {formatNumber(pack.totalCardCount)} cards
            </p>
          </div>
        </div>
      </div>

      {/* Stats row — four compact metrics, House-POV colored uniformly. */}
      <div className="grid grid-cols-4 gap-1 border-t bg-muted/20 px-3 py-2">
        <Metric
          label="Revenue"
          value={formatCurrency(pack.totalRevenue)}
          valueClass="text-emerald-600 dark:text-emerald-400"
        />
        <Metric
          label="Edge"
          value={`${toPercent(pack.actualHouseEdge).toFixed(1)}%`}
          valueClass={houseAmountTextClass(pack.actualHouseEdge)}
        />
        <Metric label="RTP" value={`${toPercent(pack.actualRtp).toFixed(1)}%`} />
        <Metric
          label="Payout"
          value={formatCurrency(pack.totalPayout)}
          valueClass="text-rose-600 dark:text-rose-400"
        />
      </div>

      {/* Mini card preview strip — skipped when no cards. */}
      {pack.cards.length > 0 && (
        <div className="flex items-center gap-1 px-3 pb-3 pt-2">
          {pack.cards.map((card) => (
            <CardImage
              key={card.id}
              src={card.imageUrl}
              alt={card.name}
              className="size-6 shrink-0 rounded-sm ring-1 ring-border"
            />
          ))}
          {pack.totalCardCount > pack.cards.length && (
            <div className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-muted text-[9px] font-medium tabular-nums">
              +{pack.totalCardCount - pack.cards.length}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Metric({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="min-w-0">
      <p className="truncate text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className={cn("truncate text-[11px] font-semibold tabular-nums", valueClass)}>
        {value}
      </p>
    </div>
  );
}
