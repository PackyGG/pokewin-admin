import { Skeleton } from "@/components/ui/skeleton";

export default function KycLoading() {
  return (
    <div className="w-full min-w-0 space-y-5">
      <div className="flex items-start gap-3 border-b border-border/60 pb-4">
        <Skeleton className="size-9 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-4 w-96 max-w-[70vw]" />
        </div>
      </div>
      <div className="grid gap-2 rounded-lg border border-border/70 p-3 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-20 rounded-md" />
        ))}
      </div>
      <Skeleton className="h-20 rounded-lg" />
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-lg" />
        ))}
      </div>
      <Skeleton className="h-80 rounded-lg" />
      <Skeleton className="h-16 rounded-lg" />
    </div>
  );
}
