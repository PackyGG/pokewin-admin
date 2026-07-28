import { Skeleton } from "@/components/ui/skeleton";

/**
 * Route-level loading skeleton for Creator Hub → ROI Calculator.
 * The page fetches nothing (pure client calculator), so this is a minimal
 * static shell mirroring the real layout: SectionHeading row, then a
 * two-column grid (input panel left, verdict + breakdown panels right).
 */
export default function ProfitableAlgoLoading() {
  return (
    <div className="space-y-4">
      {/* SectionHeading row: icon chip + title, actions right */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-7 rounded-lg" />
          <Skeleton className="h-4 w-32" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-20 rounded-md" />
          <Skeleton className="h-8 w-28 rounded-md" />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Input panel */}
        <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
          <Skeleton className="mb-4 h-3 w-3/4" />
          <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-9 w-full rounded-md" />
              </div>
            ))}
          </div>
        </div>

        {/* Output column: verdict header + breakdown panels */}
        <div className="space-y-4">
          <div className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <Skeleton className="h-9 w-24" />
              <Skeleton className="h-6 w-28 rounded-full" />
            </div>
            <Skeleton className="mt-4 h-4 w-full" />
          </div>
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-xl border bg-card p-4 shadow-sm sm:p-5">
              <div className="mb-3 flex items-center gap-2">
                <Skeleton className="size-7 rounded-lg" />
                <Skeleton className="h-3 w-28" />
              </div>
              <Skeleton className="h-8 w-32" />
              <div className="mt-3 space-y-2 border-t pt-3">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-full" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
