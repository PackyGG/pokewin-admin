import { Skeleton } from "@/components/ui/skeleton";
import { PageTitleSkeleton } from "@/components/loading-skeletons";

export default function RolePermissionsLoading() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <PageTitleSkeleton width={220} />
        <Skeleton className="h-4 w-96" />
      </div>
      <Skeleton className="h-10 w-full max-w-md" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-48 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
