import { Suspense } from "react";
import { Blocks, RadioTower } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import {
  getAntifraudEventCatalog,
  getAntifraudScoringConfig,
} from "@/lib/antifraud/monitor-api";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { FlowBuilder } from "./flow-builder";

export const metadata = { title: "Point Flows · Antifraud" };

export default async function AntifraudFlowsPage() {
  await requireAntifraudManagerPage();
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Blocks}
          accent="cyan"
          title="Point flow builder"
          subtitle="Combine player events in order and decide what happens when the sequence matches"
        />
      </PageHero>
      <Suspense fallback={<FlowBuilderSkeleton />}>
        <FlowBuilderData />
      </Suspense>
    </div>
  );
}

async function FlowBuilderData() {
  const [scoring, events] = await Promise.all([
    getAntifraudScoringConfig(),
    getAntifraudEventCatalog(),
  ]);
  if (!scoring.configured || !events.configured) {
    return <Unavailable text="The monitor service is not configured." />;
  }
  if (scoring.error || events.error || !scoring.data) {
    return <Unavailable text="The flow builder could not load the live monitor configuration." />;
  }
  return (
    <FlowBuilder
      initialRules={scoring.data.behaviorRules}
      events={events.data}
      monitorWindowSeconds={scoring.data.monitorDurationSeconds}
    />
  );
}

function Unavailable({ text }: { text: string }) {
  return (
    <div className="rounded-xl border border-dashed border-border/70 bg-card/40 px-4 py-12 text-center">
      <RadioTower className="mx-auto size-6 text-muted-foreground" aria-hidden />
      <p className="mt-2 text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

function FlowBuilderSkeleton() {
  return (
    <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
      <Skeleton className="h-[520px] rounded-xl" />
      <div className="space-y-4">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-72 rounded-xl" />
        <Skeleton className="h-40 rounded-xl" />
      </div>
    </div>
  );
}
