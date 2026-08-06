import { Skeleton } from "@/components/ui/skeleton";

/**
 * Shared chrome for the declined-deposit decision list.
 *
 * `page.tsx` and `loading.tsx` both render these, so the route-level fallback
 * and the `<Suspense>` fallback cannot drift. Before this existed, `loading.tsx`
 * showed four bare cards with no header row, so the h1 + description popped in
 * afterwards and pushed the whole list down.
 */
export function DeclinedDepositsHeader({
  count,
}: {
  /** Right-hand "N total" slot — the real count on the page, a skeleton in
   *  the fallbacks. */
  count: React.ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold">Declined deposits</h1>
        <p className="text-sm text-muted-foreground">
          Decide whether each declined payment should be refunded, the account banned, or both.
        </p>
      </div>
      {count}
    </div>
  );
}

/** Placeholder for the "N total" chip while the read is in flight. */
export function DeclinedDepositsCountSkeleton() {
  return <Skeleton className="h-4 w-16" />;
}

/** Placeholder for the decision cards while the read is in flight. */
export function DeclinedDepositsSkeleton() {
  return (
    <div className="grid gap-3">
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} className="h-44 rounded-xl" />
      ))}
    </div>
  );
}
