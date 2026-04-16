import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shared skeleton primitives for per-route loading.tsx files. Keeping
 * them in one place so every page's loading state matches its real
 * layout 1:1 — skeletons that don't match the content shape cause
 * layout jank when the content swaps in.
 */

export function PageTitleSkeleton({ width = 200 }: { width?: number }) {
  return <Skeleton className="h-8" style={{ width }} />;
}

export function StatCardRowSkeleton({
  count = 4,
  height = 120,
}: {
  count?: number;
  height?: number;
}) {
  return (
    <div
      className="grid gap-4 md:grid-cols-2"
      style={{
        gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
      }}
    >
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="rounded-xl" style={{ height }} />
      ))}
    </div>
  );
}

export function ChartRowSkeleton({
  count = 3,
  height = 300,
}: {
  count?: number;
  height?: number;
}) {
  return (
    <div
      className="grid gap-4"
      style={{
        gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
      }}
    >
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="rounded-xl" style={{ height }} />
      ))}
    </div>
  );
}

export function ToolbarSkeleton() {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Skeleton className="h-9 w-[260px]" />
      <Skeleton className="h-9 w-[120px]" />
      <Skeleton className="h-9 w-[120px]" />
    </div>
  );
}

export function CardGridSkeleton({
  count = 8,
  aspect = "3/4",
}: {
  count?: number;
  aspect?: string;
}) {
  return (
    <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton
          key={i}
          className="rounded-lg"
          style={{ aspectRatio: aspect }}
        />
      ))}
    </div>
  );
}

export function DetailHeaderSkeleton() {
  return (
    <div className="flex items-center gap-3">
      <Skeleton className="size-9 rounded-md" />
      <div className="space-y-1.5">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-32" />
      </div>
    </div>
  );
}

export function FormCardSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="rounded-xl border p-6 space-y-4">
      <Skeleton className="h-5 w-32" />
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 12 }: { rows?: number }) {
  return (
    <div className="rounded-md border">
      <div className="border-b px-4 py-3">
        <div className="flex items-center gap-4">
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-24 ml-auto" />
        </div>
      </div>
      <div className="divide-y">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="px-4 py-3">
            <div className="flex items-center gap-4">
              <Skeleton className="size-7 rounded-full" />
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-24 ml-auto" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
