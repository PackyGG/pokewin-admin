"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Mobile card-list pattern used by every admin data-table at <md viewport.
 *
 * Tables are unreadable on phones — horizontal scroll walls of text. This
 * component lets each table re-project its rows as tappable cards with a
 * primary line, a couple of secondary lines, and an optional right-aligned
 * value (amount, status, badge). One pattern, applied consistently, so
 * navigation feels native on mobile while desktop keeps the full table.
 *
 * Usage:
 *
 *   <MobileCardList
 *     items={rows}
 *     getKey={(r) => r.id}
 *     onRowClick={(r) => router.push(`/users/${r.id}`)}
 *     renderCard={(r) => ({
 *       leading: <Avatar />,
 *       primary: r.username,
 *       secondary: r.email,
 *       trailing: <Badge>{r.status}</Badge>,
 *       meta: ["1.2k wagered", "3 deposits"],
 *     })}
 *   />
 *
 * Or fully custom by passing a render function returning JSX.
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
        "flex w-full items-center gap-3 px-3 py-3 text-left transition-colors",
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
            <div className="shrink-0 text-right text-xs">
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

/**
 * List shell — wraps a sequence of cards in a rounded border container that
 * matches the desktop table's outer chrome. Render in mobile-only layouts
 * (md:hidden) so the desktop table can take over above the breakpoint.
 */
export function MobileCardList<T>({
  items,
  getKey,
  renderCard,
  onRowClick,
  emptyMessage = "No results",
  className,
  showChevron,
}: {
  items: T[];
  getKey: (item: T) => string;
  renderCard: (item: T) => MobileCardSlots;
  onRowClick?: (item: T) => void;
  emptyMessage?: React.ReactNode;
  className?: string;
  /** Show right chevron on every row. Default: true if onRowClick provided. */
  showChevron?: boolean;
}) {
  const showChev = showChevron ?? Boolean(onRowClick);
  if (items.length === 0) {
    return (
      <div
        className={cn(
          "flex h-24 items-center justify-center rounded-md border text-sm text-muted-foreground",
          className,
        )}
      >
        {emptyMessage}
      </div>
    );
  }
  return (
    <div className={cn("overflow-hidden rounded-md border", className)}>
      {items.map((item) => {
        const slots = renderCard(item);
        return (
          <MobileCard
            key={getKey(item)}
            {...slots}
            onClick={onRowClick ? () => onRowClick(item) : undefined}
            showChevron={showChev}
          />
        );
      })}
    </div>
  );
}

/**
 * Skeleton row that matches the MobileCard shape — for loading states.
 */
export function MobileCardListSkeleton({
  rows = 8,
  showLeading = true,
}: {
  rows?: number;
  showLeading?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-md border">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="flex items-center gap-3 border-b border-border/60 px-3 py-3 last:border-b-0"
        >
          {showLeading && (
            <div className="size-9 shrink-0 animate-pulse rounded-full bg-muted" />
          )}
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3.5 w-32 animate-pulse rounded bg-muted" />
            <div className="h-3 w-44 animate-pulse rounded bg-muted/60" />
          </div>
          <div className="size-12 shrink-0 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
