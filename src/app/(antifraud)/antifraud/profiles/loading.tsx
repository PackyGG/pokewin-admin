import { FormCardSkeleton, KpiStripSkeleton } from "@/components/loading-skeletons";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";

export default function Loading() {
  return (
    <div className="space-y-5">
      <PageHero><PageHeroIdentity /></PageHero>
      <KpiStripSkeleton count={3} />
      <FormCardSkeleton rows={6} />
    </div>
  );
}
