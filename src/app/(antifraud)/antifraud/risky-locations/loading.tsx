
import { FormCardSkeleton, KpiStripSkeleton } from "@/components/loading-skeletons";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";

export default function Loading() {
  return (
    <div className="space-y-4">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>
      <KpiStripSkeleton count={3} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
        <FormCardSkeleton rows={2} />
        <FormCardSkeleton rows={3} />
      </div>
    </div>
  );
}
