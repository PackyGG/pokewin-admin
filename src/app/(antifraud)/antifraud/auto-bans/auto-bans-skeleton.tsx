import { Skeleton } from "@/components/ui/skeleton";

/**
 * The ONE skeleton set for the Auto Bans route.
 *
 * Rendered from two places that must not drift apart: `loading.tsx` (shown
 * while the page's own shell — the access gate and the `searchParams` await —
 * resolves) and the two `<Suspense>` fallbacks in `page.tsx` (shown while the
 * admin reads stream in behind the already-painted shell).
 *
 * Split into KPI / search / list pieces because the real page interleaves a
 * STATIC search panel between the KPI strip and the list: the page paints that
 * panel immediately and streams the two data regions around it, so each region
 * needs its own fallback in the same DOM order.
 */

/** Mirrors the page's `grid gap-3 sm:grid-cols-2 xl:grid-cols-4` KPI strip. */
export function AutoBansKpiSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 4 }, (_, index) => (
        <div
          key={index}
          className="rounded-lg border bg-card px-3 py-2.5 sm:px-4 sm:py-3"
        >
          <div className="flex items-center gap-1.5 sm:gap-2">
            <Skeleton className="size-3.5 rounded sm:size-4" />
            <Skeleton className="h-3 w-16" />
          </div>
          <Skeleton className="mt-1.5 h-5 w-12 sm:mt-2 sm:h-6" />
        </div>
      ))}
    </div>
  );
}

/** Mirrors the static search panel — only used by `loading.tsx`. */
export function AutoBansSearchSkeleton() {
  return (
    <div className="rounded-xl border border-border/60 bg-card p-3">
      <Skeleton className="mb-1.5 h-3 w-40" />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Skeleton className="h-9 w-full sm:max-w-md" />
        <Skeleton className="h-9 w-full sm:w-24" />
      </div>
    </div>
  );
}

/** Mirrors the bordered list container with its heading and a few rows. */
export function AutoBansListSkeleton() {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
        <div className="flex items-center gap-2">
          <Skeleton className="size-7 rounded-md" />
          <Skeleton className="h-4 w-52" />
        </div>
        <Skeleton className="h-3 w-20" />
      </div>
      <div className="divide-y divide-border/60">
        {Array.from({ length: 4 }, (_, index) => (
          <div key={index} className="space-y-2 px-4 py-4">
            <Skeleton className="h-4 w-64" />
            <Skeleton className="h-4 w-full max-w-md" />
            <Skeleton className="h-3 w-full max-w-lg" />
            <Skeleton className="h-3 w-full max-w-xs" />
          </div>
        ))}
      </div>
    </div>
  );
}
