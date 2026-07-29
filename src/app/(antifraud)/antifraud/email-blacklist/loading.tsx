
import { FormCardSkeleton, KpiStripSkeleton } from "@/components/loading-skeletons";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";

export default function Loading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>
      <KpiStripSkeleton count={3} />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <FormCardSkeleton rows={1} />
        <FormCardSkeleton rows={3} />
      </div>
    </div>
  );
}
