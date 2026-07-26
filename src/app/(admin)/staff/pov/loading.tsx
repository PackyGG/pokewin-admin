import { Eye } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";

export default function SupportPovLoading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Eye}
          accent="purple"
          title="Support POV"
          subtitle="Choose a support user to preview their staff profile"
          backHref="/staff"
        />
      </PageHero>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-20 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
