import { Skeleton } from "@/components/ui/skeleton";

export default function KycLoading() {
  return (
    <div className="w-full min-w-0 space-y-5">
      <div className="flex items-start gap-3 border-b border-border/60 pb-4">
        <Skeleton className="size-9 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-5 w-20" />
          <Skeleton className="h-4 w-72 max-w-[70vw]" />
        </div>
      </div>
      <Skeleton className="h-20 rounded-lg" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-lg" />
        ))}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
      <Skeleton className="h-80 rounded-lg" />
    </div>
  );
}
