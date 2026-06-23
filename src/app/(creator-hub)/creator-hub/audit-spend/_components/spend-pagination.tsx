import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/utils/format";

import type { SpendBucketKey } from "../_queries/spend-events";

/**
 * URL-driven pagination matched to the audit-spend page. Page links
 * are real `<Link href>`s so the route prefetches the next page and the
 * Suspense `key={page}` rebuilds the table skeleton during the swap.
 *
 * Server-rendered — no Function-prop crosses the RSC boundary.
 */
export function SpendPagination({
  bucket,
  page,
  totalPages,
  total,
  perPage,
  degraded,
}: {
  bucket: SpendBucketKey;
  page: number;
  totalPages: number;
  total: number;
  perPage: number;
  degraded: boolean;
}) {
  const safePage = Math.min(Math.max(1, page), Math.max(1, totalPages));
  const start = total === 0 ? 0 : (safePage - 1) * perPage + 1;
  const end = Math.min(total, safePage * perPage);

  function hrefFor(p: number): string {
    const sp = new URLSearchParams();
    if (bucket !== "all") sp.set("bucket", bucket);
    if (p > 1) sp.set("page", String(p));
    const qs = sp.toString();
    return qs ? `/creator-hub/audit-spend?${qs}` : `/creator-hub/audit-spend`;
  }

  const isFirst = safePage <= 1;
  const isLast = safePage >= totalPages;

  function PageBtn({
    target,
    disabled,
    children,
    ariaLabel,
  }: {
    target: number;
    disabled: boolean;
    children: React.ReactNode;
    ariaLabel: string;
  }) {
    if (disabled) {
      return (
        <Button
          variant="outline"
          size="sm"
          disabled
          aria-label={ariaLabel}
          className="size-8 p-0"
        >
          {children}
        </Button>
      );
    }
    return (
      <Button
        variant="outline"
        size="sm"
        aria-label={ariaLabel}
        nativeButton={false}
        className="size-8 p-0"
        render={<Link href={hrefFor(target)} prefetch={false} />}
      >
        {children}
      </Button>
    );
  }

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-between gap-3 rounded-2xl border border-border/60 bg-background/40 px-4 py-3 sm:flex-row",
      )}
    >
      <div className="text-xs text-muted-foreground">
        {degraded ? (
          <span className="text-amber-600 dark:text-amber-400">
            Results unavailable — query degraded
          </span>
        ) : total === 0 ? (
          "0 results"
        ) : (
          <>
            Showing{" "}
            <span className="font-medium text-foreground">
              {formatNumber(start)}–{formatNumber(end)}
            </span>{" "}
            of <span className="font-medium text-foreground">{formatNumber(total)}</span>{" "}
            events
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <PageBtn target={1} disabled={isFirst} ariaLabel="First page">
          <ChevronsLeft className="size-4" />
        </PageBtn>
        <PageBtn
          target={safePage - 1}
          disabled={isFirst}
          ariaLabel="Previous page"
        >
          <ChevronLeft className="size-4" />
        </PageBtn>
        <div className="px-1 text-xs text-muted-foreground tabular-nums">
          Page{" "}
          <span className="font-medium text-foreground">{safePage}</span> of{" "}
          <span className="font-medium text-foreground">
            {Math.max(1, totalPages)}
          </span>
        </div>
        <PageBtn
          target={safePage + 1}
          disabled={isLast}
          ariaLabel="Next page"
        >
          <ChevronRight className="size-4" />
        </PageBtn>
        <PageBtn target={totalPages} disabled={isLast} ariaLabel="Last page">
          <ChevronsRight className="size-4" />
        </PageBtn>
      </div>
    </div>
  );
}
