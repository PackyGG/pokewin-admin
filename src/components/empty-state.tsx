import * as React from "react";
import { cn } from "@/lib/utils";
import { TILE_COLORS, type AccentColor } from "@/components/modern-panels";

/**
 * Shared empty-state primitive — a centered icon-chip + title + optional
 * description + optional action. Replaces the ad-hoc "No X found" blocks
 * hand-rolled across the admin pages so empty states look consistent
 * everywhere (same chip aesthetic as KpiTile/StatPanel, dark-mode aware,
 * responsive padding).
 *
 * Two sizes:
 *   - default — page / section level empty (generous vertical room)
 *   - compact — inside a table body or a small card (tighter)
 *
 * Accent is optional: omit it for the neutral muted look (the common
 * case); pass a TILE_COLORS token when the empty state benefits from a
 * subtle accent (e.g. an emerald "all caught up" state). Money/House-POV
 * semantics are the caller's responsibility — this is purely chrome.
 *
 * Canonical usage patterns (use these, don't roll your own "No rows" block):
 *
 *   1. Inside a desktop `<Table>` body — render under a single cell that
 *      spans every column so the empty row spans the full width:
 *        <TableRow className="hover:bg-transparent">
 *          <TableCell colSpan={columns.length} className="p-0">
 *            <EmptyState icon={Receipt} title="No transactions found"
 *                        description="…" compact />
 *          </TableCell>
 *        </TableRow>
 *
 *   2. Inside the mobile card list — wrap in a bordered container so the
 *      empty state visually matches the surrounding cards:
 *        <div className="rounded-md border">
 *          <EmptyState icon={Receipt} title="…" compact />
 *        </div>
 *
 *   3. Page / section level (e.g. "no caps set yet") — drop the `compact`
 *      flag for generous vertical breathing room.
 *
 * Pairs with FilterToolbar (`@/components/filter-toolbar`) — together
 * they make the list-page chrome consistent across the admin.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  accent,
  compact = false,
  className,
}: {
  icon?: React.ElementType;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  accent?: AccentColor;
  compact?: boolean;
  className?: string;
}) {
  const colors = accent ? TILE_COLORS[accent] : null;
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-2 px-4 py-8" : "gap-3 px-6 py-12 sm:py-16",
        className,
      )}
    >
      {Icon && (
        <div
          className={cn(
            "flex shrink-0 items-center justify-center rounded-xl border",
            compact ? "size-9" : "size-12",
            colors ? colors.bg : "border-border/60 bg-muted/50",
          )}
        >
          <Icon
            className={cn(
              compact ? "size-4" : "size-6",
              colors ? colors.icon : "text-muted-foreground",
            )}
          />
        </div>
      )}
      <div className="space-y-1">
        <p className={cn("font-semibold", compact ? "text-sm" : "text-sm sm:text-base")}>
          {title}
        </p>
        {description && (
          <p className="mx-auto max-w-sm text-xs text-muted-foreground sm:text-sm">
            {description}
          </p>
        )}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
