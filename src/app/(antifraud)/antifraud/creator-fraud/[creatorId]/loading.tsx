import { Skeleton } from "@/components/ui/skeleton";

export default function CreatorFraudDetailLoading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-24 rounded-xl" />
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}
