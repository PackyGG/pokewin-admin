"use client";

import Link from "next/link";
import { ExternalLink, Gift, Package } from "lucide-react";

import { CardImage } from "@/components/card-image";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import type { PackCardPreview } from "./_model";

/** Horizontal scroll of pool cards — larger tiles with price labels. */
export function CardPoolRibbon({
  cards,
  className,
}: {
  cards: PackCardPreview[];
  className?: string;
}) {
  if (cards.length === 0) return null;

  return (
    <div
      className={cn(
        "flex gap-2 overflow-x-auto border-b bg-muted/30 px-3 py-2.5 [-ms-overflow-style:none] [scrollbar-width:thin]",
        className,
      )}
    >
      {cards.map((c, i) => (
        <div
          key={`${c.name}-${i}`}
          className="w-[4.5rem] shrink-0"
          title={`${c.name} · ${formatCurrency(c.priceUsd)}`}
        >
          <div className="aspect-[3/4] overflow-hidden rounded-md border bg-background shadow-sm">
            <CardImage src={c.imageUrl} alt={c.name} className="size-full" />
          </div>
          <p className="mt-1 truncate text-[9px] font-medium leading-tight">{c.name}</p>
          <p className="truncate text-[9px] tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(c.priceUsd)}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * Daily-pack tuner tile — hero pack art, visible card pool, stats, and a slot
 * for the EV slider (passed as children from the planner).
 */
export function DailyPackTunerCard({
  packId,
  name,
  slug,
  imageUrl,
  cardPreviews,
  opens,
  claimers,
  measuredEvUsd,
  plannedEvUsd,
  plannedPackCost,
  formatEv,
  children,
  inactive = false,
  className,
}: {
  packId: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  cardPreviews: PackCardPreview[];
  opens: number;
  claimers: number;
  measuredEvUsd: number;
  plannedEvUsd: number;
  plannedPackCost: string;
  formatEv: (n: number) => string;
  children: React.ReactNode;
  /** No opens in the selected window — theoretical EV only. */
  inactive?: boolean;
  className?: string;
}) {
  const evChanged = Math.abs(plannedEvUsd - measuredEvUsd) > 0.0001;

  return (
    <article
      className={cn(
        "flex flex-col overflow-hidden rounded-2xl border bg-card shadow-sm ring-1 ring-border/40",
        inactive && "opacity-90",
        className,
      )}
    >
      <Link
        href={`/packs/${packId}`}
        className="group relative block aspect-[5/4] overflow-hidden bg-muted"
        title={`Edit ${name} in pack admin`}
      >
        <CardImage src={imageUrl} alt={name} className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.04]" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/75 via-black/15 to-transparent" />
        <div className="absolute left-3 top-3 flex flex-wrap gap-1">
          <Badge className="border-0 bg-pink-500/90 text-[10px] text-white hover:bg-pink-500/90">
            Daily pack
          </Badge>
          {inactive ? (
            <Badge variant="secondary" className="text-[10px]">
              No opens
            </Badge>
          ) : null}
        </div>
        <div className="absolute bottom-0 left-0 right-0 p-3">
          <h3 className="truncate text-base font-bold leading-tight text-white">{name}</h3>
          <p className="truncate text-[11px] text-white/75">{slug}</p>
        </div>
        <span className="absolute right-3 top-3 flex items-center gap-1 rounded-md bg-black/50 px-2 py-1 text-[10px] font-medium text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
          <ExternalLink className="size-3" />
          Edit pack
        </span>
      </Link>

      <CardPoolRibbon cards={cardPreviews} />

      <div className="flex flex-1 flex-col gap-3 p-3.5">
        <div className="grid grid-cols-2 gap-2">
          <PackStat label="Opens" value={opens.toLocaleString()} />
          <PackStat label="Claimers" value={claimers.toLocaleString()} />
          <PackStat
            label="Measured EV"
            value={formatEv(measuredEvUsd)}
            tone="muted"
          />
          <PackStat
            label="Planned EV"
            value={formatEv(plannedEvUsd)}
            tone={evChanged ? "changed" : "muted"}
          />
        </div>

        <div className="flex items-center justify-between rounded-lg bg-rose-500/10 px-2.5 py-1.5 text-[11px]">
          <span className="text-muted-foreground">Window cost (planned)</span>
          <span className="font-bold tabular-nums text-rose-600 dark:text-rose-400">
            {plannedPackCost}
          </span>
        </div>

        <div className="mt-auto border-t pt-3">{children}</div>
      </div>
    </article>
  );
}

function PackStat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "muted" | "changed";
}) {
  return (
    <div className="rounded-lg border border-border/50 bg-muted/25 px-2 py-1.5">
      <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-0.5 truncate text-sm font-bold tabular-nums",
          tone === "changed" && "text-amber-600 dark:text-amber-400",
          tone === "muted" && "text-foreground/80",
        )}
      >
        {value}
      </p>
    </div>
  );
}

/** Compact catalog tile (reference only — no tuner). */
export function PackCatalogTile({
  packId,
  name,
  slug,
  imageUrl,
  cardPreviews,
  active,
  cardsPerOpen,
}: {
  packId: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  cardPreviews: PackCardPreview[];
  active: boolean;
  cardsPerOpen: number;
}) {
  return (
    <Link
      href={`/packs/${packId}`}
      className="group flex flex-col overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-md"
    >
      <div className="relative aspect-square overflow-hidden bg-muted">
        <CardImage src={imageUrl} alt={name} className="size-full object-cover" />
        <Badge
          variant="secondary"
          className={cn(
            "absolute left-2 top-2 h-5 text-[9px]",
            active ? "bg-emerald-500/90 text-white" : "bg-muted/90",
          )}
        >
          {active ? "Active" : "Off"}
        </Badge>
      </div>
      <div className="space-y-1 p-2">
        <p className="truncate text-xs font-semibold">{name}</p>
        <p className="truncate text-[10px] text-muted-foreground">{slug}</p>
        <div className="flex items-center justify-between gap-1">
          <PackCardStrip cards={cardPreviews} />
          <span className="shrink-0 text-[9px] text-muted-foreground">
            {cardsPerOpen}/open
          </span>
        </div>
      </div>
    </Link>
  );
}

export function PackCardStrip({
  cards,
  className,
}: {
  cards: PackCardPreview[];
  className?: string;
}) {
  if (cards.length === 0) return null;

  return (
    <div className={cn("flex -space-x-1.5", className)}>
      {cards.slice(0, 3).map((c, i) => (
        <div
          key={`${c.name}-${i}`}
          className="relative size-6 shrink-0 overflow-hidden rounded border border-background bg-muted"
          title={c.name}
        >
          <CardImage src={c.imageUrl} alt={c.name} className="size-full" />
        </div>
      ))}
    </div>
  );
}

export function RewardPackCatalogGrid({
  packs,
  compact = false,
}: {
  packs: {
    packId: string;
    name: string;
    slug: string;
    imageUrl: string | null;
    cardPreviews: PackCardPreview[];
    active: boolean;
    cardsPerOpen: number;
  }[];
  compact?: boolean;
}) {
  if (packs.length === 0) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-dashed bg-muted/20 px-3 py-4 text-xs text-muted-foreground">
        <Package className="size-4 shrink-0" />
        No reward packs in the catalog.
      </div>
    );
  }

  return (
    <div
      className={cn(
        "grid gap-2",
        compact
          ? "grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6"
          : "sm:grid-cols-2 md:grid-cols-3",
      )}
    >
      {packs.map((p) => (
        <PackCatalogTile
          key={p.packId}
          packId={p.packId}
          name={p.name}
          slug={p.slug}
          imageUrl={p.imageUrl}
          cardPreviews={p.cardPreviews}
          active={p.active}
          cardsPerOpen={p.cardsPerOpen}
        />
      ))}
    </div>
  );
}

export function WelcomePackTunerCard({
  packId,
  packName,
  packSlug,
  rewardName,
  rewardSlug,
  imageUrl,
  cardPreviews,
  theoreticalEvUsd,
  cardsPerOpen,
}: {
  packId: string;
  packName: string;
  packSlug: string;
  rewardName: string;
  rewardSlug: string;
  imageUrl: string | null;
  cardPreviews: PackCardPreview[];
  theoreticalEvUsd: number;
  cardsPerOpen: number;
}) {
  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border bg-card shadow-sm">
      <Link
        href={`/packs/${packId}`}
        className="group relative block aspect-[4/3] overflow-hidden bg-muted"
      >
        <CardImage src={imageUrl} alt={packName} className="size-full object-cover transition-transform group-hover:scale-[1.03]" />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
        <div className="absolute bottom-0 left-0 right-0 p-3">
          <Badge variant="secondary" className="mb-1 text-[10px]">
            {rewardName}
          </Badge>
          <h4 className="truncate font-bold text-white">{packName}</h4>
          <p className="text-[11px] text-white/75">{rewardSlug}</p>
        </div>
      </Link>
      <CardPoolRibbon cards={cardPreviews} />
      <div className="grid grid-cols-2 gap-2 p-3 text-xs">
        <PackStat label="Theoretical EV" value={formatCurrency(theoreticalEvUsd)} tone="muted" />
        <PackStat label="Cards / open" value={String(cardsPerOpen)} />
      </div>
    </article>
  );
}

export function WelcomePackGrid({
  packs,
}: {
  packs: {
    packId: string;
    packName: string;
    packSlug: string;
    rewardName: string;
    rewardSlug: string;
    imageUrl: string | null;
    cardPreviews: PackCardPreview[];
    theoreticalEvUsd: number;
    cardsPerOpen: number;
  }[];
}) {
  if (packs.length === 0) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Gift className="size-3.5 text-pink-500" />
        Welcome / one-time pack grants (display-only EV)
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {packs.map((w) => (
          <WelcomePackTunerCard key={`${w.rewardSlug}-${w.packId}`} {...w} />
        ))}
      </div>
    </div>
  );
}
