import * as React from "react";
import Link from "next/link";
import { CardImage } from "@/components/card-image";
import { cn } from "@/lib/utils";
import { houseAmountTextClass } from "@/lib/house-pov";

/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Entity cell helpers  (pokewin-admin · src/components/entity-surface)
 * ──────────────────────────────────────────────────────────────────────────
 *
 * Small, composable cell renderers for <EntityTable> columns, shared by /packs
 * and /cards so the table cells look identical across surfaces. Each is a plain
 * presentational component — no data fetching, no hooks.
 *
 * Server-safe (CardImage is a client component but renders fine inside a server
 * tree as part of the column `cell` output).
 */

/**
 * Leading "entity" cell: a small square thumbnail + a primary name line and an
 * optional secondary line (slug / set / type). The thumbnail uses the existing
 * <CardImage> (handles fallback + lazy load). Long names truncate with a title.
 */
export function EntityNameCell({
  imageUrl,
  name,
  secondary,
  thumbClassName,
  badge,
  href,
}: {
  imageUrl: string | null;
  name: string;
  secondary?: React.ReactNode;
  /** Tint/ring on the thumbnail frame (e.g. rarity ring). */
  thumbClassName?: string;
  /** Inline node after the name (e.g. an ActiveBadge / rarity dot). */
  badge?: React.ReactNode;
  /**
   * When set, the thumbnail + name become a real `<a href>` (Next.js Link),
   * so the browser's native right-click "Open in new tab" works and
   * ctrl/cmd/middle-click open a new tab — without losing fast SPA nav on a
   * plain left-click. Omit to render a plain (non-link) cell.
   */
  href?: string;
}) {
  const thumb = (
    <div
      className={cn(
        "relative size-8 shrink-0 overflow-hidden rounded-md bg-muted/40 ring-1 ring-border",
        thumbClassName,
      )}
    >
      <CardImage
        src={imageUrl}
        alt={name}
        className="absolute inset-0 size-full"
      />
    </div>
  );
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {href ? (
        <Link href={href} className="shrink-0" aria-label={name} tabIndex={-1}>
          {thumb}
        </Link>
      ) : (
        thumb
      )}
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          {href ? (
            <Link
              href={href}
              className="truncate text-sm font-medium outline-none hover:underline focus-visible:underline"
              title={name}
            >
              {name}
            </Link>
          ) : (
            <span className="truncate text-sm font-medium" title={name}>
              {name}
            </span>
          )}
          {badge}
        </div>
        {secondary != null && (
          <div className="truncate text-xs text-muted-foreground">
            {secondary}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * A right-aligned numeric/money cell. When `houseAmount` is supplied the value
 * is tinted by the House-POV rule (positive house figure → emerald, negative →
 * rose) via the centralized helper — for an edge / P&L column. For a neutral
 * figure (price, opens, count) omit `houseAmount` and it renders in the default
 * foreground.
 */
export function ValueCell({
  children,
  houseAmount,
  sub,
  muted = false,
  className,
}: {
  children: React.ReactNode;
  /** Signed HOUSE figure that drives the color. Omit for neutral values. */
  houseAmount?: number;
  /** Small secondary line under the value (e.g. "payout $1.2k"). */
  sub?: React.ReactNode;
  /** Render the value in muted color (e.g. a zero / empty figure). */
  muted?: boolean;
  className?: string;
}) {
  const colorClass =
    houseAmount != null
      ? houseAmountTextClass(houseAmount)
      : muted
        ? "text-muted-foreground/70"
        : "text-foreground";
  return (
    <div className={cn("flex flex-col items-end", className)}>
      <span className={cn("font-medium tabular-nums", colorClass)}>
        {children}
      </span>
      {sub != null && (
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {sub}
        </span>
      )}
    </div>
  );
}

/**
 * A small rarity dot — shared with the card-tile palette so the table and the
 * gallery speak the same visual language. Re-exports `getRarityDot` styling
 * inline to avoid importing the client card-tile module into a server cell.
 */
const RARITY_DOT: Record<string, string> = {
  common: "bg-zinc-400",
  uncommon: "bg-emerald-500",
  rare: "bg-blue-500",
  "ultra rare": "bg-purple-500",
  "secret rare": "bg-pink-500",
  secret: "bg-yellow-500",
  legendary: "bg-orange-500",
  holo: "bg-cyan-500",
};

export function RarityDot({ rarity }: { rarity: string | null | undefined }) {
  const dot =
    RARITY_DOT[(rarity ?? "").toLowerCase()] ?? "bg-muted-foreground/40";
  return (
    <span
      className={cn("size-1.5 shrink-0 rounded-full", dot)}
      aria-hidden
    />
  );
}
