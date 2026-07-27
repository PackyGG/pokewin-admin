import { Blocks } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Blocks}
          accent="cyan"
          title="Point flow builder"
          subtitle="Combine player events in order and decide what happens when the sequence matches"
          backHref="/antifraud"
        />
      </PageHero>
      <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
        <Skeleton className="h-[520px] rounded-xl" />
        <Skeleton className="h-[680px] rounded-xl" />
      </div>
    </div>
  );
}
