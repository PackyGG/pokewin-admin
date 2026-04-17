"use client";

import * as React from "react";
import Link from "next/link";
import { CardImage } from "@/components/card-image";
import { formatCurrency } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

/**
 * Shared card tile primitive. Used by the /cards catalog grid and the
 * /packs/[id] card grid so both surfaces share one single source of truth.
 *
 * The tile is intentionally compact: card image sits inside a padded frame,
 * rarity accent tints the top bar + image ring, and below the image we stack
 * a short name row plus optional sparse data rows (set, price, probability,
 * etc.) in tabular-nums. Everything is built from the existing design
 * tokens — no new colors, no new animations.
 */

// Compact rarity color palette. Keys must be lowercased before lookup.
// Kept in sync with the `/cards` original palette so the visual vocabulary
// stays consistent across pages.
const RARITY_DOT: Record<string, string> = {
  common: "bg-zinc-400",
  uncommon: "bg-green-500",
  rare: "bg-blue-500",
  "ultra rare": "bg-purple-500",
  "secret rare": "bg-pink-500",
  secret: "bg-yellow-500",
  legendary: "bg-orange-500",
  holo: "bg-cyan-500",
};

const RARITY_RING: Record<string, string> = {
  common: "ring-zinc-500/20",
  uncommon: "ring-green-500/30",
  rare: "ring-blue-500/30",
  "ultra rare": "ring-purple-500/40",
  "secret rare": "ring-pink-500/40",
  secret: "ring-yellow-500/40",
  legendary: "ring-orange-500/40",
  holo: "ring-cyan-500/40",
};

function rarityKey(rarity: string | null | undefined): string {
  return (rarity ?? "").toLowerCase();
}

export function getRarityDot(rarity: string | null | undefined): string {
  return RARITY_DOT[rarityKey(rarity)] ?? "bg-muted-foreground/40";
}

export function getRarityRing(rarity: string | null | undefined): string {
  return RARITY_RING[rarityKey(rarity)] ?? "ring-border";
}

/**
 * One-line key/value row used in the tile body. Kept as a named export so
 * callers can compose custom rows (e.g. probability, weight, order) without
 * needing to re-derive the styling.
 */
export function TileDataRow({
  label,
  value,
  valueClassName,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-1 text-[10px] leading-tight">
      <span className="truncate text-muted-foreground">{label}</span>
      <span
        className={cn(
          "shrink-0 font-medium tabular-nums text-foreground/90",
          valueClassName,
        )}
      >
        {value}
      </span>
    </div>
  );
}

export type CardTileProps = {
  id: string;
  name: string;
  imageUrl: string | null;
  rarity?: string | null;
  /** Shown as a subtle small text under the name. */
  subtitle?: string | null;
  /** If provided the tile is a <Link>, otherwise a static <div>. */
  href?: string;
  /** Small chip shown top-right of the image (e.g. "#4" for pack order). */
  topBadge?: React.ReactNode;
  /** Price rendered as a chip over the image's bottom-right corner. */
  priceUsd?: number;
  /** Extra rows rendered below the name (composed via <TileDataRow />). */
  extraRows?: React.ReactNode;
  /** Tightens vertical rhythm when multiple rows are stacked. */
  className?: string;
};

/**
 * Render a single card tile. Matches the compact 10-per-row catalog grid
 * pattern — image is padded inside the container (not edge-to-edge), rarity
 * tints the top accent line + image ring, and the footer carries a tiny
 * rarity dot next to the card name.
 */
export function CardTile({
  id,
  name,
  imageUrl,
  rarity,
  subtitle,
  href,
  topBadge,
  priceUsd,
  extraRows,
  className,
}: CardTileProps) {
  const dot = getRarityDot(rarity);
  const ring = getRarityRing(rarity);

  const body = (
    <>
      {/* Rarity accent line — a hair on top, tinted by rarity. */}
      <div className={cn("h-0.5 w-full", dot)} aria-hidden />

      {/* Image frame — padded inside the container (not edge-to-edge). The
          tighter 5/7 aspect makes the image feel calmer than the 3/4 it
          was before while still matching the natural card proportion. */}
      <div className="relative px-2 pt-2">
        <div
          className={cn(
            "relative overflow-hidden rounded-lg bg-muted/40 ring-1",
            ring,
          )}
          style={{ aspectRatio: "5 / 7" }}
        >
          <CardImage
            src={imageUrl}
            alt={name}
            className="absolute inset-0 size-full motion-safe:transition-transform motion-safe:duration-200 motion-safe:group-hover:scale-[1.03]"
          />

          {topBadge && (
            <div className="absolute top-1 right-1 rounded-md bg-background/85 px-1.5 py-0.5 text-[10px] font-mono font-semibold tabular-nums shadow-sm ring-1 ring-border backdrop-blur-sm">
              {topBadge}
            </div>
          )}

          {priceUsd !== undefined && priceUsd > 0 && (
            <div className="absolute bottom-1 right-1 rounded-md bg-background/85 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums shadow-sm ring-1 ring-border backdrop-blur-sm">
              {formatCurrency(priceUsd)}
            </div>
          )}
        </div>
      </div>

      {/* Footer: name + rarity dot + optional sparse data rows. */}
      <div className="flex flex-col gap-1 px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <span
            className={cn("size-1.5 shrink-0 rounded-full", dot)}
            aria-hidden
          />
          <h3
            className="min-w-0 flex-1 truncate text-[11px] font-medium leading-tight group-hover:text-primary"
            title={name}
          >
            {name}
          </h3>
        </div>
        {subtitle && (
          <p
            className="truncate pl-3 text-[10px] text-muted-foreground"
            title={subtitle}
          >
            {subtitle}
          </p>
        )}
        {extraRows && <div className="flex flex-col gap-0.5 pt-0.5">{extraRows}</div>}
      </div>
    </>
  );

  const wrapperClass = cn(
    "group relative flex flex-col overflow-hidden rounded-xl border bg-card/50",
    "transition-all duration-200",
    "motion-safe:hover:-translate-y-0.5 hover:shadow-md hover:bg-card hover:border-primary/40",
    className,
  );

  if (href) {
    return (
      <Link key={id} href={href} className={wrapperClass}>
        {body}
      </Link>
    );
  }

  return (
    <div key={id} className={wrapperClass}>
      {body}
    </div>
  );
}
