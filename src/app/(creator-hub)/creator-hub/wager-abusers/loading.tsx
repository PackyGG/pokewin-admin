import { Skeleton } from "@/components/ui/skeleton";

export default function WagerAbusersLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-[72px] w-full rounded-2xl" />
      <div className="space-y-4">
        <Skeleton className="h-[88px] max-w-xs rounded-xl" />
        <div className="rounded-2xl border bg-card p-4">
          <div className="flex items-center justify-between">
            <Skeleton className="h-4 w-32 rounded" />
            <Skeleton className="h-3 w-24 rounded" />
          </div>
          <div className="mt-4 space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
