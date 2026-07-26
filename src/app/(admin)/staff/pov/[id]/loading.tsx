import { Eye } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";

export default function SupportPovDetailLoading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Eye}
          accent="purple"
          title="Support POV"
          subtitle="Loading the support profile preview"
          backHref="/staff/pov"
        />
      </PageHero>
      <Skeleton className="h-12 rounded-xl" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-24 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="h-20 rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}
