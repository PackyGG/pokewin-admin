"use client";

import { useRouter, useSearchParams } from "next/navigation";
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
}: {
  page: number;
  totalPages: number;
  total: number;
  perPage: number;
  /** URL search-param key holding the 1-based page index. */
  pageKey?: string;
  /** URL search-param key holding the rows-per-page value. */
  perPageKey?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function navigate(newPage: number, newPerPage?: number) {
    const params = new URLSearchParams(searchParams.toString());
    params.set(pageKey, String(newPage));
    if (newPerPage) params.set(perPageKey, String(newPerPage));
    router.push(`?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-4">
      <p className="text-xs sm:text-sm text-muted-foreground">
        {total} result{total !== 1 ? "s" : ""}
      </p>
      {/* Mobile: simple Prev / Page X of Y / Next */}
      <div className="flex items-center gap-2 sm:hidden">
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2"
          onClick={() => navigate(page - 1)}
          disabled={page <= 1}
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
          disabled={page >= totalPages}
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
              {[10, 20, 50, 100].map((n) => (
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
            disabled={page <= 1}
            aria-label="Go to first page"
          >
            <ChevronsLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => navigate(page - 1)}
            disabled={page <= 1}
            aria-label="Go to previous page"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => navigate(page + 1)}
            disabled={page >= totalPages}
            aria-label="Go to next page"
          >
            <ChevronRight className="size-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            onClick={() => navigate(totalPages)}
            disabled={page >= totalPages}
            aria-label="Go to last page"
          >
            <ChevronsRight className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
