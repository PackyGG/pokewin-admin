import { Skeleton } from "@/components/ui/skeleton";

export default function KycLoading() {
  return (
    <div className="w-full min-w-0 space-y-6">
      <div className="flex items-start gap-3 border-b border-border/60 pb-4">
        <Skeleton className="size-9 rounded-lg" />
        <div className="space-y-2">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-4 w-96 max-w-[70vw]" />
        </div>
      </div>
      <Skeleton className="h-24 rounded-xl" />
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-80 rounded-xl" />
        <Skeleton className="h-16 rounded-xl" />
      </div>
    </div>
  );
}
