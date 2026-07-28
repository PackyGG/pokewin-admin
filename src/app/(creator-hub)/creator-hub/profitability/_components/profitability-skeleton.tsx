import { Skeleton } from "@/components/ui/skeleton";

/**
 * ProfitabilitySkeleton — the ONE skeleton for the Profitability page,
 * shared by the route-level `loading.tsx` (tab-unaware: renders the common
 * shell both tabs share) and the in-page `<Suspense>` fallbacks (tab-aware:
 * the Past tab adds the cold-load honesty note).
 *
 * Shape mirrors the live sections: 3 headline KPI tiles (flat, rounded-lg),
 * the compact secondary stat line, then the row-list card.
 */
export function ProfitabilitySkeleton({
  coldLoadNote = false,
}: {
  /**
   * Past tab only: the per-board affiliate-PnL scan is the heaviest read in
   * the Creator Hub — a cold (uncached) load can take up to ~1 minute
   * (documented incident; `maxDuration = 120`). Shows a muted honesty line
   * so the wait reads as expected, not broken.
   */
  coldLoadNote?: boolean;
}) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[92px] rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-9 rounded-lg" />
        {coldLoadNote && (
          <p className="text-[11px] text-muted-foreground">
            Computing deal frames — a cold load can take up to a minute.
          </p>
        )}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-[76px] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
