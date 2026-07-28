import { Skeleton } from "@/components/ui/skeleton";

/**
 * ONE skeleton source for `/creator-hub/tips-sponsors` — the route
 * `loading.tsx` and the per-stream Suspense fallbacks all compose these
 * pieces, so the placeholder layout always mirrors the real section
 * structure (headline tile strip → reconciliation row → chart → ranklist)
 * instead of two drifting hand-rolled variants.
 */

/** Fallback for the session-derived headline tiles (2 of the 3-tile strip). */
export function HeadlineSessionTilesSkeleton() {
  return (
    <>
      <Skeleton className="h-[88px] rounded-lg" />
      <Skeleton className="h-[88px] rounded-lg" />
    </>
  );
}

/** Fallback for the ledger-derived lifetime tile (3rd headline tile). */
export function HeadlineLifetimeTileSkeleton() {
  return <Skeleton className="h-[88px] rounded-lg" />;
}

/** Fallback for the session-vs-ledger reconciliation row. */
export function ReconciliationSkeleton() {
  return <Skeleton className="h-[72px] rounded-xl" />;
}

/** Fallback for the fixed 30-day daily spend chart panel. */
export function ChartSkeleton() {
  return <Skeleton className="h-[340px] rounded-xl" />;
}

/** Fallback for the per-creator spend ranklist. */
export function RanklistSkeleton() {
  return (
    <div className="space-y-2.5">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-[64px] rounded-xl" />
      ))}
    </div>
  );
}

/** Section-heading placeholder (icon chip + title line). */
function HeadingSkeleton() {
  return <Skeleton className="h-7 w-48 rounded-lg" />;
}

/**
 * Full-page body skeleton — rendered by `loading.tsx` (below the static
 * heading row it recreates itself) and mirroring the exact section order
 * the page streams in.
 */
export function TipsSponsorsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <HeadingSkeleton />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <HeadlineSessionTilesSkeleton />
          <HeadlineLifetimeTileSkeleton />
        </div>
      </div>
      <div className="space-y-3">
        <HeadingSkeleton />
        <ReconciliationSkeleton />
      </div>
      <div className="space-y-3">
        <HeadingSkeleton />
        <ChartSkeleton />
      </div>
      <div className="space-y-3">
        <HeadingSkeleton />
        <RanklistSkeleton />
      </div>
    </div>
  );
}
