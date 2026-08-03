import { Skeleton } from "@/components/ui/skeleton";

export default function AntifraudConfigLoading() {
  return (
    <div className="space-y-6" aria-label="Loading Antifraud config">
      <Skeleton className="h-24 w-full rounded-xl" />
      <Skeleton className="h-6 w-48 rounded-md" />
      <Skeleton className="h-52 w-full rounded-xl" />
    </div>
  );
}
