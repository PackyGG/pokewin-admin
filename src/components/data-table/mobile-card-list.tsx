"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Mobile card primitive used by admin data-tables at <md viewport.
 *
 * Tables are unreadable on phones — horizontal scroll walls of text. This
 * component lets each table re-project a row as a tappable card with a
 * primary line, a couple of secondary lines, and an optional right-aligned
 * value (amount, status, badge). One pattern, applied consistently, so
 * navigation feels native on mobile while desktop keeps the full table.
 *
 * Usage — render one per row inside a md:hidden bordered container:
 *
 *   <MobileCard
 *     leading={<Avatar />}
 *     primary={r.username}
 *     secondary={r.email}
 *     trailing={<Badge>{r.status}</Badge>}
 *     meta={["1.2k wagered", "3 deposits"]}
 *     onClick={() => router.push(`/users/${r.id}`)}
 *   />
 */

export type MobileCardSlots = {
  /** Left-most slot — typically an avatar or icon (40px). Optional. */
  leading?: React.ReactNode;
  /** Primary text (most important field). */
  primary: React.ReactNode;
  /** Subtitle (1 line). */
  secondary?: React.ReactNode;
  /** Right-aligned content — amount, status badge, etc. */
  trailing?: React.ReactNode;
  /** Optional row of small inline meta items rendered under primary/secondary. */
  meta?: React.ReactNode[];
  /** Footer row (bottom of card) — used for date/time and tags. */
  footer?: React.ReactNode;
};

export function MobileCard({
  leading,
  primary,
  secondary,
  trailing,
  meta,
  footer,
  onClick,
  selected,
  showChevron,
}: MobileCardSlots & {
  onClick?: () => void;
  selected?: boolean;
  /** Show the right chevron when this row navigates somewhere on tap. */
  showChevron?: boolean;
}) {
  const interactive = Boolean(onClick);
  const Cmp = interactive ? "button" : "div";
  return (
    <Cmp
      type={interactive ? "button" : undefined}
      onClick={onClick}
      data-selected={selected || undefined}
      className={cn(
        "flex w-full items-center gap-3 px-3 py-3 text-left motion-safe:transition-colors",
        "border-b border-border/60 last:border-b-0",
        "min-h-[56px]",
        interactive && "hover:bg-muted/40 active:bg-muted/60 cursor-pointer",
        selected && "bg-accent/30",
      )}
    >
      {leading && <div className="shrink-0">{leading}</div>}
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium leading-tight">
              {primary}
            </div>
            {secondary && (
              <div className="truncate text-xs text-muted-foreground leading-tight mt-0.5">
                {secondary}
              </div>
            )}
          </div>
          {trailing && (
            // tabular-nums: the trailing slot is almost always an amount /
            // count, so digits align vertically down a card list.
            <div className="shrink-0 text-right text-xs tabular-nums">
              {trailing}
            </div>
          )}
        </div>
        {meta && meta.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 text-[11px] text-muted-foreground">
            {meta.map((m, i) => (
              <React.Fragment key={i}>{m}</React.Fragment>
            ))}
          </div>
        )}
        {footer && (
          <div className="pt-1 text-[11px] text-muted-foreground">
            {footer}
          </div>
        )}
      </div>
      {showChevron && interactive && (
        <ChevronRight className="size-4 shrink-0 text-muted-foreground/60" />
      )}
    </Cmp>
  );
}
