import { Skeleton } from "@/components/ui/skeleton";

export default function AntifraudPointsLoading() {
  return (
    <div className="w-full space-y-5">
      <div className="space-y-2 border-b border-border/60 pb-4">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-16 rounded-lg" />
      <Skeleton className="h-20 rounded-lg" />
      <Skeleton className="h-52 rounded-lg" />
      <Skeleton className="h-52 rounded-lg" />
    </div>
  );
}
