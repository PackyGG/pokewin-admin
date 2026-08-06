"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Client-side pager for the claim queue sections.
 *
 * WHY NOT `HubPagination`: that one is URL-driven (`?page=N`), which is right
 * when the server does the slicing. Here it can't. `getClaims({ status?,
 * limit? })` takes no offset, so the page already holds the whole capped
 * window in memory, and the search/program filters that decide what is being
 * paged are client state — "page 3" is page 3 OF THE FILTERED SET, which the
 * server has no way to know. A URL flip would cost a full round-trip to
 * re-slice data the browser is already holding.
 *
 * So the control mirrors `HubPagination`'s look and wording exactly (outline sm
 * Previous/Next, "x / y", a range summary on the left) — the same precedent
 * `ProfitabilityList` set for the Hub's other in-memory list — and paging feels
 * identical to the eye across the whole Hub.
 */
export function QueuePager({
  page,
  pageCount,
  first,
  last,
  total,
  noun,
  onPageChange,
}: {
  /** 1-indexed, already clamped by the caller. */
  page: number;
  pageCount: number;
  first: number;
  last: number;
  total: number;
  noun: string;
  onPageChange: (page: number) => void;
}) {
  if (pageCount <= 1) return null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-xs tabular-nums text-muted-foreground">
        {first}–{last} of {total} {noun}
      </span>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
          aria-label={`Previous page of ${noun}`}
        >
          <ChevronLeft className="size-3.5" aria-hidden /> Previous
        </Button>
        <span className="text-xs tabular-nums text-muted-foreground">
          {page} / {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="gap-1"
          disabled={page >= pageCount}
          onClick={() => onPageChange(page + 1)}
          aria-label={`Next page of ${noun}`}
        >
          Next <ChevronRight className="size-3.5" aria-hidden />
        </Button>
      </div>
    </div>
  );
}
