import { Skeleton } from "@/components/ui/skeleton";

export default function KycLoading() {
  return (
    <div className="w-full min-w-0 space-y-6">
      <Skeleton className="h-24 rounded-xl" />
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {Array.from({ length: 4 }, (_, index) => (
            <Skeleton key={index} className="h-24 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-80 rounded-xl" />
      </div>
    </div>
  );
}
