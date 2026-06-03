import { Skeleton } from "@/components/ui/skeleton";
import {
  DetailHeroSkeleton,
  KpiStripSkeleton,
  SectionHeadingSkeleton,
} from "@/components/loading-skeletons";

/**
 * Route-level skeleton for /cards/[id]. Re-matched to the LIVE detail layout
 * (it had drifted to a 3/4 image + single Card panel): detail hero with the
 * rarity badge + edit/delete actions, a 6-tile KPI strip, then the
 * artwork-left / StatPanel-grid-right split — the artwork in a rounded card at
 * the card's natural aspect, and five stat panels (Catalog / Game stats /
 * Economy / Identifiers / Timestamps) in a 2-col grid. Closes with the
 * optional "packs containing this card" grid. CLS-safe against the real page.
 */
export default function CardDetailLoading() {
  return (
    <div className="space-y-6">
      <DetailHeroSkeleton action />
      <KpiStripSkeleton count={6} />

      <div className="space-y-3">
        <SectionHeadingSkeleton titleWidth={160} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
          {/* Artwork card */}
          <div className="rounded-2xl border bg-card p-4">
            <Skeleton
              className="w-full rounded-lg"
              style={{ aspectRatio: "5 / 7" }}
            />
          </div>
          {/* Five StatPanels in a 2-col grid */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-3 rounded-2xl border bg-card p-4">
                <div className="flex items-center gap-2">
                  <Skeleton className="size-7 rounded-lg" />
                  <Skeleton className="h-4 w-24 rounded" />
                </div>
                {Array.from({ length: 4 }).map((_, r) => (
                  <div key={r} className="flex items-center justify-between gap-2">
                    <Skeleton className="h-3 w-16 rounded" />
                    <Skeleton className="h-3 w-20 rounded" />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
