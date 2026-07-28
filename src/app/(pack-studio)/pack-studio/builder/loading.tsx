import { Wand2 } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { BuilderSkeleton } from "./builder-skeleton";

/**
 * Route-level loading shell for the Pack Builder — renders the same hero +
 * skeleton the page's <Suspense> fallback uses, so the first paint is identical
 * whether the route is streaming or the segment is loading.
 */
export default function PackBuilderLoading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Wand2}
          accent="purple"
          title="Pack Builder"
          subtitle="Compose a new pack, tune its feel, and watch the edge live."
        />
      </PageHero>
      <BuilderSkeleton />
    </div>
  );
}
