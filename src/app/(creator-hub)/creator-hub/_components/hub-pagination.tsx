"use client";

import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useHostHref } from "@/lib/use-app-host";

/**
 * HubPagination — the ONE server-driven pager for Creator Hub lists.
 *
 * Replaces the three implementations that grew across the Hub (raw anchors on
 * socials-review, client-state buttons on the active profitability list,
 * `buttonVariants` links on past deals). URL-driven (`?{paramKey}=N`), so
 * every paged view is deep-linkable and back-button friendly.
 *
 * `basePath` is the CANONICAL in-app path (e.g. "/creator-hub/creators");
 * it is resolved host-aware so the pager keeps clean URLs on
 * marketing.packydash.com. `extraParams` carries the view's other query
 * state (tab/status/period) so paging never drops it.
 */
export function HubPagination({
  basePath,
  page,
  pageCount,
  paramKey = "page",
  extraParams,
  summary,
  className,
}: {
  basePath: string;
  /** 1-indexed current page. */
  page: number;
  pageCount: number;
  paramKey?: string;
  extraParams?: Record<string, string | undefined>;
  /** Optional "start–end of total" line rendered on the left. */
  summary?: React.ReactNode;
  className?: string;
}) {
  const resolvedBase = useHostHref(basePath);

  const hrefFor = (target: number) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(extraParams ?? {})) {
      if (value != null && value !== "") params.set(key, value);
    }
    // Page 1 is canonical without the param.
    if (target > 1) params.set(paramKey, String(target));
    const qs = params.toString();
    return qs ? `${resolvedBase}?${qs}` : resolvedBase;
  };

  const linkClass = cn(
    buttonVariants({ variant: "outline", size: "sm" }),
    "gap-1",
  );

  const prevDisabled = page <= 1;
  const nextDisabled = page >= pageCount;

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-2",
        className,
      )}
    >
      <div className="text-xs text-muted-foreground">{summary}</div>
      <div className="flex items-center gap-2">
        {prevDisabled ? (
          <Button variant="outline" size="sm" disabled className="gap-1">
            <ChevronLeft className="size-3.5" aria-hidden /> Previous
          </Button>
        ) : (
          <Link
            href={hrefFor(page - 1)}
            scroll={false}
            className={linkClass}
            aria-label="Previous page"
          >
            <ChevronLeft className="size-3.5" aria-hidden /> Previous
          </Link>
        )}
        <span className="text-xs tabular-nums text-muted-foreground">
          {page} / {Math.max(pageCount, 1)}
        </span>
        {nextDisabled ? (
          <Button variant="outline" size="sm" disabled className="gap-1">
            Next <ChevronRight className="size-3.5" aria-hidden />
          </Button>
        ) : (
          <Link
            href={hrefFor(page + 1)}
            scroll={false}
            className={linkClass}
            aria-label="Next page"
          >
            Next <ChevronRight className="size-3.5" aria-hidden />
          </Link>
        )}
      </div>
    </div>
  );
}
