"use client";

import { useEffect, useState } from "react";
import { Flame, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { usePromoCodesSelection } from "./promo-codes-selection-context";
import { getAllDeletablePromoCodeIds } from "./actions";

/**
 * Quick-select buttons for /promo-codes — one-click select of every spent
 * code so the owner can hand them straight to the existing bulk-delete.
 * Each button replaces the current selection with exactly its set; the
 * live count badge makes clear what gets selected before the click.
 *
 * /promo-codes is SERVER-side paginated (the table only ever holds one
 * page), so these buttons act on the WHOLE table, not just the visible
 * page: on mount we fetch the full used-up / expired id sets across ALL
 * pages from the server (`getAllDeletablePromoCodeIds`, same predicates
 * the table uses per-row). Clicking selects that full set; the badge
 * shows the true total. The subsequent bulk-delete (which chunks its
 * `deleteMany`) removes every selected code, not just the page's worth.
 *
 * Fallback: until the server set resolves — and if it ever fails / times
 * out and degrades to empty — we fall back to the current page's
 * candidates (published by the table via the selection provider), so the
 * buttons still work immediately on the visible page and never regress
 * below per-page behaviour.
 *
 * Rendered as the toolbar's trailing `children`, so it sits in the SAME
 * horizontal row as the search input + status filter. Renders nothing
 * when there are no used-up / expired codes anywhere (and while the table
 * is still streaming, before either source has any ids).
 */
export function PromoCodesQuickSelect() {
  const { candidates, selectExactly, dataVersion } = usePromoCodesSelection();

  // Full-dataset sets across all pages. `null` until the first fetch
  // resolves; an empty-but-non-null result means "fetched, none match".
  const [allExhausted, setAllExhausted] = useState<string[] | null>(null);
  const [allExpired, setAllExpired] = useState<string[] | null>(null);

  // Re-fetch on mount AND whenever `dataVersion` bumps (after a successful
  // bulk-delete), so the badge counts drop the codes that were just
  // deleted — the component stays mounted across `router.refresh()` and
  // would otherwise keep the pre-delete totals.
  useEffect(() => {
    let active = true;
    getAllDeletablePromoCodeIds()
      .then((res) => {
        if (!active) return;
        setAllExhausted(res.data.exhaustedIds);
        setAllExpired(res.data.expiredIds);
      })
      .catch(() => {
        // Network/transport failure: leave at `null` so the per-page
        // fallback below stays in effect — never crash the toolbar.
        if (!active) return;
        setAllExhausted(null);
        setAllExpired(null);
      });
    return () => {
      active = false;
    };
  }, [dataVersion]);

  // Prefer the full-dataset set once it has resolved with at least one id;
  // otherwise fall back to the current page's candidates. (An empty
  // full-set that resolved AFTER a non-empty page set still falls back to
  // the page set so the button never disappears mid-interaction.)
  const exhaustedIds =
    allExhausted && allExhausted.length > 0
      ? allExhausted
      : candidates.exhaustedIds;
  const expiredIds =
    allExpired && allExpired.length > 0 ? allExpired : candidates.expiredIds;

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
