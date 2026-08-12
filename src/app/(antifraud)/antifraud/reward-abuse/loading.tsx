import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-24 rounded-xl" />
      <Skeleton className="h-72 rounded-xl" />
      <Skeleton className="h-72 rounded-xl" />
    </div>
  );
}
