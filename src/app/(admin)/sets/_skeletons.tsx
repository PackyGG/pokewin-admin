import { Skeleton } from "@/components/ui/skeleton";

/**
 * Layout-matching skeleton for the /sets list.
 *
 * Mirrors <SetsContent> 1:1 across both breakpoints so the loading → data
 * swap is shift-free: a mobile card list (<lg) and the desktop 4-column
 * table (Name · Cards · Added · Actions) at lg+. Row heights are fixed so
 * the skeleton reserves the exact vertical space the real rows occupy —
 * the old flat `h-64` block jumped when the table streamed in.
 *
 * Shimmer + reduced-motion are inherited from the base <Skeleton>.
 */
export function SetsTableSkeleton({ rows = 10 }: { rows?: number }) {
  return (
    <div className="space-y-4">
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        <div className="overflow-hidden rounded-md border">
          {Array.from({ length: rows }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 border-b border-border/60 px-3 py-3 last:border-b-0"
            >
              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Skeleton className="h-3.5 w-32 rounded" />
                  <Skeleton className="h-2.5 w-12 rounded" />
                </div>
                <Skeleton className="h-2.5 w-20 rounded" />
              </div>
              <div className="flex items-center gap-1">
                <Skeleton className="size-7 rounded-md" />
                <Skeleton className="size-7 rounded-md" />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden overflow-hidden rounded-md border lg:block">
        {/* Header row — matches TableHeader (Name, Cards right, Added, Actions right). */}
        <div className="border-b bg-muted/50 px-4 py-3">
          <div className="flex items-center gap-4">
            <Skeleton className="h-4 w-16 rounded" />
            <Skeleton className="ml-auto h-4 w-12 rounded" />
            <Skeleton className="h-4 w-16 rounded" />
            <Skeleton className="h-4 w-16 rounded" />
          </div>
        </div>
        <div className="divide-y">
          {Array.from({ length: rows }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-4 px-4"
              style={{ height: 53 }}
            >
              <Skeleton className="h-4 w-40 rounded" />
              <Skeleton className="ml-auto h-4 w-10 rounded" />
              <Skeleton className="h-4 w-24 rounded" />
              <div className="flex items-center justify-end gap-1">
                <Skeleton className="size-7 rounded-md" />
                <Skeleton className="size-7 rounded-md" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
