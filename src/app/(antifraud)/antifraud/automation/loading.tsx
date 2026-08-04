import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";

export default function AntifraudAutomationLoading() {
  return (
    <div className="space-y-4">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>
      <div className="space-y-2">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>
      {/* Tab bar */}
      <Skeleton className="h-11 w-full max-w-md rounded-lg" />
      {/* Overview is the default tab: KPI strip → issue board → pipeline */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-40 rounded-xl" />
    </div>
  );
}
