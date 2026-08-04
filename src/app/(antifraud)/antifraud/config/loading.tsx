import { Skeleton } from "@/components/ui/skeleton";

export default function AntifraudConfigLoading() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-24 rounded-lg" />
      <div className="space-y-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-5 w-full max-w-2xl" />
      </div>
      <Skeleton className="h-56 w-full rounded-xl" />
      <Skeleton className="h-52 w-full rounded-xl" />
    </div>
  );
}
