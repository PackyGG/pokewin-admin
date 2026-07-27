import { Network } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";

export default function AccountNetworksLoading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Network}
          accent="cyan"
          title="Account networks"
          subtitle="Trace complete signup-IP and device connections across accounts"
        />
      </PageHero>
      <Skeleton className="h-[122px] rounded-xl" />
      <Skeleton className="h-[560px] rounded-xl" />
    </div>
  );
}
