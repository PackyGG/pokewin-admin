"use client";

import { Flame, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { usePromoCodesSelection } from "./promo-codes-selection-context";

/**
 * Quick-select buttons for /promo-codes — one-click select of the spent
 * codes on the current page so the owner can hand them straight to the
 * existing bulk-delete. Each button replaces the current selection with
 * exactly its set; the live count badge makes clear what gets selected
 * before the click.
 *
 * Rendered as the toolbar's trailing `children`, so it sits in the SAME
 * horizontal row as the search input + status filter (next to the filter
 * dropdown), matching their height. The candidate id sets come from the
 * table via <PromoCodesSelectionProvider> (the table is the only place
 * that has the loaded page rows); clicking writes the shared
 * `rowSelection`, which the table renders and the bulk-action bar acts on
 * — the exact same select → bulk-delete flow as before, just relocated
 * into the toolbar.
 *
 * Renders nothing when the page has no exhausted / expired codes (and
 * while the table is still streaming in, before it registers any
 * candidates), so the toolbar row stays clean in that case.
 */
export function PromoCodesQuickSelect() {
  const { candidates, selectExactly } = usePromoCodesSelection();
  const { exhaustedIds, expiredIds } = candidates;

  if (exhaustedIds.length === 0 && expiredIds.length === 0) return null;

  return (
    // Sits inside the toolbar's trailing filter group (`sm:contents`), so
    // these become peers of the search input + filter dropdown in one row.
    // `h-9` matches the filter dropdown + the toolbar's "Clear" button so
    // everything lines up on one baseline; wraps gracefully on narrow
    // widths via the toolbar's `flex-wrap`.
    <div className="flex flex-wrap items-center gap-2">
      {exhaustedIds.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => selectExactly(exhaustedIds)}
          className="h-9 gap-1.5"
        >
          <Flame className="size-3.5 text-amber-500" />
          Select used-up
          <Badge
            variant="outline"
            className="ml-1 h-4 px-1 text-[10px] tabular-nums border-amber-500/30 bg-amber-500/15 text-amber-600 dark:text-amber-400"
          >
            {exhaustedIds.length}
          </Badge>
        </Button>
      )}
      {expiredIds.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => selectExactly(expiredIds)}
          className="h-9 gap-1.5"
        >
          <Clock className="size-3.5 text-rose-500" />
          Select expired
          <Badge
            variant="outline"
            className="ml-1 h-4 px-1 text-[10px] tabular-nums border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400"
          >
            {expiredIds.length}
          </Badge>
        </Button>
      )}
    </div>
  );
}
