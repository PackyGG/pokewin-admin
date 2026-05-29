import { Skeleton } from "@/components/ui/skeleton";
import {
  KpiStripSkeleton,
  PageHeroSkeleton,
} from "@/components/loading-skeletons";

export default function UpgraderLoading() {
  return (
    <div className="space-y-6">
      <PageHeroSkeleton action />
      <KpiStripSkeleton count={4} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
        {Array.from({ length: 24 }).map((_, i) => (
          <Skeleton
            key={i}
            className="rounded-xl"
            style={{ aspectRatio: "3 / 4.6" }}
          />
        ))}
      </div>
    </div>
  );
}
