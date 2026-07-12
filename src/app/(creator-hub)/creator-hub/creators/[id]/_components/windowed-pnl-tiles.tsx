import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function WindowedPnlTilesSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {[0, 1, 2, 3, 4].map((i) => (
        <Card key={i} size="sm" className="space-y-2 p-4">
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-3 w-20" />
          <div className="space-y-1.5 pt-1">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-full" />
          </div>
        </Card>
      ))}
    </div>
  );
}
