import { PageHeroSkeleton } from "@/components/loading-skeletons";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for /analytics/pure-pnl — keeps the shell
 * visible on a cold navigation while `getPackBattlePurePnl` resolves
 * (inventory + ledger reads over the 24h / 3d / 7d / lifetime windows).
 *
 * Mirrors the page chrome 1:1: the hero (no action — this page has no
 * filter control) over the single Raw P&L panel. The panel reproduces the
 * real card's header (title + multi-line description) and the per-window
 * table (4 window columns + the Combined / Packs / Battles source blocks),
 * so nothing jumps when the data lands.
 */
export default function PurePnlLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton />

      {/* Raw P&L panel — header + per-window table. */}
      <div className="rounded-2xl border bg-gradient-to-br from-card via-card to-card/80 p-4 sm:p-5">
        <div className="mb-4 space-y-2">
          <Skeleton className="h-5 w-48 rounded" />
          <Skeleton className="h-3 w-full max-w-2xl rounded" />
          <Skeleton className="h-3 w-4/5 max-w-2xl rounded" />
        </div>

        <div className="overflow-hidden rounded-xl border">
          {/* Header row — Source · Metric · 4 windows. */}
          <div className="flex items-center gap-4 border-b bg-muted/50 px-3 py-2.5">
            <Skeleton className="h-3.5 w-16 rounded" />
            <Skeleton className="ml-auto h-3.5 w-12 rounded" />
            <Skeleton className="h-3.5 w-16 rounded" />
            <Skeleton className="h-3.5 w-16 rounded" />
            <Skeleton className="h-3.5 w-16 rounded" />
          </div>
          {/* Body rows — Combined + Per-source (Packs / Battles). */}
          <div className="divide-y">
            {Array.from({ length: 9 }).map((_, r) => (
              <div key={r} className="flex items-center gap-4 px-3 py-2.5">
                {r % 3 === 0 ? (
                  <div className="flex items-center gap-2">
                    <Skeleton className="size-7 shrink-0 rounded-md" />
                    <Skeleton className="h-4 w-20 rounded" />
                  </div>
                ) : (
                  <Skeleton className="h-3.5 w-16 rounded" />
                )}
                <Skeleton className="ml-auto h-3.5 w-14 rounded" />
                <Skeleton className="h-3.5 w-16 rounded" />
                <Skeleton className="h-3.5 w-16 rounded" />
                <Skeleton className="h-3.5 w-16 rounded" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
