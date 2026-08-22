import { Skeleton } from "@/components/ui/skeleton";

/** Body of one finance card — the caption, the big number, the detail
 *  tiles, and the footnote. Split out so a card whose HEADER is static
 *  (the Profit card, which carries the period chips) can stream only its
 *  content while still falling back to the identical shape. */
export function FinanceCardContentSkeleton() {
  return (
    <div className="space-y-6 px-4 pt-4">
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-12 w-48" />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-16 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-4 w-full" />
    </div>
  );
}

/** One whole finance card. `withChips` reserves the period-selector slot
 *  so the Profit card's fallback is the same width as the real header. */
export function FinanceCardSkeleton({
  withChips = false,
}: {
  withChips?: boolean;
}) {
  return (
    <div className="min-h-[310px] rounded-2xl bg-card py-4 ring-1 ring-foreground/10">
      <div className="flex items-start justify-between gap-4 border-b px-4 pb-4">
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-4 w-40" />
        </div>
        {withChips && <Skeleton className="h-9 w-52 rounded-lg" />}
      </div>
      <FinanceCardContentSkeleton />
    </div>
  );
}

export function FinancesOverviewSkeleton() {
  return (
    <div className="space-y-4">
      <FinanceCardSkeleton withChips />
      <div className="grid gap-4 lg:grid-cols-2">
        <FinanceCardSkeleton />
        <FinanceCardSkeleton />
      </div>
      <FinanceCardSkeleton />
      <FinanceCardSkeleton />
    </div>
  );
}
