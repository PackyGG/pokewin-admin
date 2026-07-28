"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Handshake } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CreatorProfitabilityRow } from "../_queries/deal-profitability";
import { HubEmptyState } from "../../_components/hub-notice";
import { DealRow } from "./deal-row";

/** Creators per page — rows are already loaded, this is a client-side slice. */
const PAGE_SIZE = 25;

/**
 * Active-tab list — a thin wrapper: rows render through the shared
 * `DealRow` (variant "active"), empty state through `HubEmptyState`.
 *
 * Pagination is CLIENT-SIDE (the full active roster is already in props —
 * a URL flip would only re-render the same data), but the control mirrors
 * the shared `HubPagination` look (outline sm Previous/Next + "x / y") so
 * both tabs page identically to the eye.
 */
export function ProfitabilityList({
  rows,
}: {
  rows: CreatorProfitabilityRow[];
}) {
  const [page, setPage] = useState(1);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = useMemo(
    () => rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [rows, safePage],
  );

  if (rows.length === 0) {
    return (
      <HubEmptyState
        icon={Handshake}
        title="No creators with a current deal"
        sub="Nothing to cost out yet — creators appear here once a deal frame is active or scheduled."
      />
    );
  }

  const first = (safePage - 1) * PAGE_SIZE + 1;
  const last = Math.min(safePage * PAGE_SIZE, rows.length);

  return (
    <div className="space-y-3">
      <div className="divide-y overflow-hidden rounded-2xl border bg-card">
        {pageRows.map((row) => (
          <DealRow key={row.userId} variant="active" row={row} />
        ))}
      </div>

      {rows.length > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {first}–{last} of {rows.length} creators
          </span>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={safePage <= 1}
              onClick={() => setPage(safePage - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft className="size-3.5" aria-hidden /> Previous
            </Button>
            <span className="text-xs tabular-nums text-muted-foreground">
              {safePage} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={safePage >= totalPages}
              onClick={() => setPage(safePage + 1)}
              aria-label="Next page"
            >
              Next <ChevronRight className="size-3.5" aria-hidden />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
