"use client";

import Link from "next/link";
import { ExternalLink } from "lucide-react";

import { CardImage } from "@/components/card-image";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import type { PackCardPreview } from "./_model-v2";

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
        "flex gap-2 overflow-x-auto border-b bg-muted/30 px-3 py-2 [-ms-overflow-style:none] [scrollbar-width:thin]",
        className,
      )}
    >
      {cards.map((c, i) => (
        <div key={`${c.name}-${i}`} className="w-[4rem] shrink-0">
          <div className="aspect-[3/4] overflow-hidden rounded-md border bg-background shadow-sm">
            <CardImage src={c.imageUrl} alt={c.name} className="size-full" />
          </div>
          <p className="mt-0.5 truncate text-[9px] font-medium">{c.name}</p>
          <p className="truncate text-[9px] tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(c.priceUsd)}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * Pack-first tuner — hero art dominates; EV slider sits directly under the pool.
 */
export function PackFirstTunerCard({
  packId,
  name,
  slug,
  imageUrl,
  cardPreviews,
  measuredEvUsd,
  plannedEvUsd,
  subtitle,
  badge,
  href = `/packs/${packId}`,
  inactive,
  slider,
  footerStats,
}: {
  packId: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  cardPreviews: PackCardPreview[];
  measuredEvUsd: number;
  plannedEvUsd: number;
  subtitle?: string;
  badge?: string;
  href?: string;
  inactive?: boolean;
  slider: React.ReactNode;
  footerStats?: React.ReactNode;
}) {
  const evChanged = Math.abs(plannedEvUsd - measuredEvUsd) > 0.0001;

  return (
    <article
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border bg-card/80 shadow-sm ring-1 ring-border/50",
        inactive && "opacity-90",
      )}
    >
      <Link
        href={href}
        className="group relative block aspect-[16/10] overflow-hidden bg-muted sm:aspect-[2/1]"
      >
        <CardImage
          src={imageUrl}
          alt={name}
          className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
        />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
        <div className="absolute left-3 top-3 flex flex-wrap gap-1">
          {badge ? (
            <Badge className="border-0 bg-violet-500/90 text-[10px] text-white">
              {badge}
            </Badge>
          ) : null}
          {inactive ? (
            <Badge variant="secondary" className="text-[10px]">
              Planning default
            </Badge>
          ) : null}
        </div>
        <div className="absolute bottom-0 left-0 right-0 p-3">
          <h3 className="truncate text-lg font-bold text-white">{name}</h3>
          <p className="truncate text-xs text-white/75">{slug}</p>
          {subtitle ? (
            <p className="mt-1 text-[11px] text-white/60">{subtitle}</p>
          ) : null}
        </div>
        <span className="absolute right-3 top-3 flex items-center gap-1 rounded-md bg-black/50 px-2 py-1 text-[10px] text-white opacity-0 backdrop-blur-sm transition-opacity group-hover:opacity-100">
          <ExternalLink className="size-3" />
          Edit
        </span>
      </Link>

      <CardPoolRibbon cards={cardPreviews} />

      <div className="space-y-3 border-b bg-muted/15 px-3 py-3">{slider}</div>

      <div className="grid grid-cols-2 gap-2 px-3 py-2.5 text-[11px]">
        <div>
          <span className="text-muted-foreground">Measured EV</span>
          <p className="font-semibold tabular-nums">{formatCurrency(measuredEvUsd)}</p>
        </div>
        <div className="text-right">
          <span className="text-muted-foreground">Planned EV</span>
          <p
            className={cn(
              "font-semibold tabular-nums",
              evChanged
                ? "text-rose-600 dark:text-rose-400"
                : "text-muted-foreground",
            )}
          >
            {formatCurrency(plannedEvUsd)}
          </p>
        </div>
      </div>

      {footerStats ? (
        <div className="border-t bg-background/50 px-3 py-2.5">{footerStats}</div>
      ) : null}
    </article>
  );
}
