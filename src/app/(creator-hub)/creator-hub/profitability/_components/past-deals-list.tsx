"use client";

import { AlertTriangle, History } from "lucide-react";

import {
  HubEmptyState,
  HubNotice,
} from "../../_components/hub-notice";
import { HubPagination } from "../../_components/hub-pagination";
import type { PastDealRow } from "../_queries/past-deals";
import { DealRow } from "./deal-row";

/**
 * Past-tab list — a thin wrapper: rows render through the shared `DealRow`
 * (variant "past" — its middle cell shows Affiliates Made Us instead of the
 * active variant's Time Left), degraded/empty states through
 * `HubNotice`/`HubEmptyState`.
 *
 * Pagination is SERVER-SIDE via `?page=`, rendered through the shared
 * `HubPagination` (extraParams keeps `?tab=past` so paging never falls back
 * to the Active tab); the page link flips the URL param, the parent
 * `<Suspense key={`past-${page}`}>` shows the skeleton, and the server
 * re-renders just the next page's 25 rows.
 */
export function PastDealsList({
  rows,
  page,
  totalPages,
  totalCount,
  backendUnavailable,
}: {
  rows: PastDealRow[];
  page: number;
  totalPages: number;
  totalCount: number;
  backendUnavailable: boolean;
}) {
  if (backendUnavailable) {
    return (
      <HubNotice tone="amber" icon={AlertTriangle} title="Past deals unavailable">
        Couldn&apos;t load past deals from the backend. Try refreshing in a
        moment.
      </HubNotice>
    );
  }

  if (rows.length === 0) {
    return (
      <HubEmptyState
        icon={History}
        title="No past deals yet"
        sub="Every approved leaderboard frame is still live or upcoming."
      />
    );
  }

  const first = (page - 1) * 25 + 1;
  const last = Math.min(page * 25, totalCount);

  return (
    <div className="space-y-3">
      <div className="divide-y overflow-hidden rounded-2xl border bg-card">
        {rows.map((row) => (
          <DealRow key={row.boardId} variant="past" row={row} />
        ))}
      </div>

      {totalPages > 1 && (
        <HubPagination
          basePath="/creator-hub/profitability"
          page={page}
          pageCount={totalPages}
          extraParams={{ tab: "past" }}
          summary={`${first}–${last} of ${totalCount} past deals`}
        />
      )}
    </div>
  );
}
