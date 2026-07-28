import { Skeleton } from "@/components/ui/skeleton";

export default function CreatorFraudLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-14 rounded-xl" />
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
