"use client";

import Link from "next/link";
import { ExternalLink, Gift, Package } from "lucide-react";

import { CardImage } from "@/components/card-image";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils/format";
import type { PackCardPreview } from "./_model";

export function PackCardStrip({
  cards,
  className,
}: {
  cards: PackCardPreview[];
  className?: string;
}) {
  if (cards.length === 0) return null;

  return (
    <div className={cn("flex -space-x-2", className)}>
      {cards.slice(0, 4).map((c, i) => (
        <div
          key={`${c.name}-${i}`}
          className="relative size-9 shrink-0 overflow-hidden rounded-md border-2 border-background bg-muted shadow-sm"
          title={`${c.name} · ${formatCurrency(c.priceUsd)}`}
        >
          <CardImage src={c.imageUrl} alt={c.name} className="size-full" />
        </div>
      ))}
    </div>
  );
}

export function PackDesignCard({
  packId,
  name,
  slug,
  imageUrl,
  cardPreviews,
  badge,
  meta,
  evLabel,
  costLabel,
  href = `/packs/${packId}`,
  className,
  children,
}: {
  packId: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  cardPreviews: PackCardPreview[];
  badge?: string;
  meta?: React.ReactNode;
  evLabel?: string;
  costLabel?: string;
  href?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border bg-gradient-to-br from-card via-card to-muted/20 transition-shadow hover:shadow-md",
        className,
      )}
    >
      <div className="flex gap-3 p-3">
        <Link
          href={href}
          className="relative block size-20 shrink-0 overflow-hidden rounded-lg border bg-muted/40 ring-offset-background transition-transform hover:scale-[1.02] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={`Open ${name} in packs admin`}
        >
          <CardImage src={imageUrl} alt={name} className="size-full" />
          <span className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-0.5 bg-black/55 py-0.5 text-[9px] font-medium text-white opacity-0 transition-opacity group-hover:opacity-100">
            <ExternalLink className="size-2.5" />
            View pack
          </span>
        </Link>

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <h4 className="truncate text-sm font-semibold leading-tight">{name}</h4>
                {badge ? (
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                    {badge}
                  </Badge>
                ) : null}
              </div>
              <p className="truncate text-[11px] text-muted-foreground">{slug}</p>
            </div>
            {(evLabel || costLabel) && (
              <div className="shrink-0 text-right">
                {evLabel ? (
                  <p className="text-xs font-bold tabular-nums text-rose-600 dark:text-rose-400">
                    {evLabel}
                  </p>
                ) : null}
                {costLabel ? (
                  <p className="text-[10px] tabular-nums text-muted-foreground">{costLabel}</p>
                ) : null}
              </div>
            )}
          </div>

          {meta ? <div className="mt-1.5 text-[11px] text-muted-foreground">{meta}</div> : null}

          {cardPreviews.length > 0 ? (
            <div className="mt-2 flex items-center gap-2">
              <PackCardStrip cards={cardPreviews} />
              <span className="text-[10px] text-muted-foreground">Top pool cards</span>
            </div>
          ) : null}
        </div>
      </div>

      {children ? <div className="border-t bg-muted/20 px-3 py-2.5">{children}</div> : null}
    </div>
  );
}

export function RewardPackCatalogGrid({
  packs,
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
    <div className="grid gap-3 sm:grid-cols-2">
      {packs.map((p) => (
        <PackDesignCard
          key={p.packId}
          packId={p.packId}
          name={p.name}
          slug={p.slug}
          imageUrl={p.imageUrl}
          cardPreviews={p.cardPreviews}
          badge={p.active ? "Active" : "Inactive"}
          meta={
            <>
              {p.cardsPerOpen} card{p.cardsPerOpen === 1 ? "" : "s"} / open
            </>
          }
        />
      ))}
    </div>
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
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <Gift className="size-3.5 text-pink-500" />
        Welcome / one-time pack grants
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {packs.map((w) => (
          <PackDesignCard
            key={`${w.rewardSlug}-${w.packId}`}
            packId={w.packId}
            name={w.packName}
            slug={w.packSlug}
            imageUrl={w.imageUrl}
            cardPreviews={w.cardPreviews}
            badge={w.rewardName}
            meta={
              <>
                Reward <span className="font-medium text-foreground">{w.rewardSlug}</span>
                {" · "}
                {w.cardsPerOpen} card{w.cardsPerOpen === 1 ? "" : "s"}/open
              </>
            }
            evLabel={formatCurrency(w.theoreticalEvUsd)}
            costLabel="theoretical EV / open"
          />
        ))}
      </div>
    </div>
  );
}
