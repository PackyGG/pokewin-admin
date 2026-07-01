"use client";

import { useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";

export function DataTablePagination({
  page,
  totalPages,
  total,
  perPage,
  pageKey = "page",
  perPageKey = "perPage",
  degraded = false,
}: {
  page: number;
  totalPages: number;
  total: number;
  perPage: number;
  /** URL search-param key holding the 1-based page index. */
  pageKey?: string;
  /** URL search-param key holding the rows-per-page value. */
  perPageKey?: string;
  /**
   * Set when the list query failed/timed out (e.g. via safeQuery, which
   * returns an empty fallback with `total = 0`). In that case "0 results"
   * is misleading — it reads as "the filter matched nothing" right next to
   * an error notice that says the query couldn't load. When `degraded` is
   * true the count line shows "Results unavailable" instead. Defaults to
   * false so existing callers keep their exact behavior.
   */
  degraded?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Same-view page/perPage navigation runs through a transition so the
  // controls surface a pending cue (dimmed + non-interactive) while the next
  // page streams in — instead of feeling like a dead click with no feedback.
  // The row data is a server component, so React keeps the current rows
  // visible during the transition (no skeleton flash on same-view paging).
  const [isPending, startTransition] = useTransition();

  function navigate(newPage: number, newPerPage?: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(pageKey, String(newPage));
    if (newPerPage) params.set(perPageKey, String(newPerPage));
    startTransition(() => router.push(`?${params.toString()}`));
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-4",
        // Pending cue: dim the whole control while the next page loads.
        // Color/opacity only, `motion-safe:`-gated, so reduced-motion users
        // get the state instantly with no tween.
        "motion-safe:transition-opacity motion-safe:duration-200",
        isPending && "opacity-60",
      )}
      aria-busy={isPending || undefined}
    >
      <p className="text-xs sm:text-sm text-muted-foreground">
        {degraded
          ? "Results unavailable"
          : `${total} result${total !== 1 ? "s" : ""}`}
      </p>
      {/* Mobile: simple Prev / Page X of Y / Next */}
      <div className="flex items-center gap-2 sm:hidden">
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2"
          onClick={() => navigate(page - 1)}
          disabled={page <= 1 || isPending}
          aria-label="Previous page"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums px-1">
          {page} / {totalPages || 1}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2"
          onClick={() => navigate(page + 1)}
          disabled={page >= totalPages || isPending}
          aria-label="Next page"
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
      {/* Desktop: full controls (rows-per-page, jump-to-first/last) */}
      <div className="hidden flex-wrap items-center gap-x-4 gap-y-2 sm:flex">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Rows</span>
          <Select
            value={String(perPage)}
            onValueChange={(v) => navigate(1, Number(v))}
          >
            <SelectTrigger className="h-8 w-[70px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[10, 20, 50, 100, 200].map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <span className="text-sm text-muted-foreground">
          Page {page} of {totalPages || 1}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => navigate(1)}
            disabled={page <= 1 || isPending}
            aria-label="Go to first page"
          >
            <ChevronsLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => navigate(page - 1)}
            disabled={page <= 1 || isPending}
            aria-label="Go to previous page"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => navigate(page + 1)}
            disabled={page >= totalPages || isPending}
            aria-label="Go to next page"
          >
            <ChevronRight className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => navigate(totalPages)}
            disabled={page >= totalPages || isPending}
            aria-label="Go to last page"
          >
            <ChevronsRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
