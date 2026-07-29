
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";

export default function AccountNetworksLoading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>
      <Skeleton className="h-[122px] rounded-xl" />
      <Skeleton className="h-[560px] rounded-xl" />
    </div>
  );
}
