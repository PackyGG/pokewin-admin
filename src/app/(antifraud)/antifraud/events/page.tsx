import { Suspense } from "react";
import { RadioTower } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { getAntifraudEventCatalog } from "@/lib/antifraud/monitor-api";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { PanelErrorBoundary } from "../_components/panel-error-boundary";
import { EventCatalog } from "./event-catalog";

export const metadata = { title: "Events & Triggers · Antifraud" };

export default async function AntifraudEventsPage() {
  await requireAntifraudManagerPage();
  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>
      <Suspense fallback={<CatalogSkeleton />}>
        <CatalogData />
      </Suspense>
    </div>
  );
}
async function CatalogData() {
  const result = await getAntifraudEventCatalog();
  if (!result.configured) {
    return <Unavailable text="The monitor service is not configured." />;
  }
  if (result.error) {
    return <Unavailable text="The event catalog could not be loaded." />;
  }
  return (
    <PanelErrorBoundary label="Event catalog">
      <EventCatalog events={result.data} />
    </PanelErrorBoundary>
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

function CatalogSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-12 rounded-xl" />
      <Skeleton className="h-[520px] rounded-xl" />
    </div>
  );
}
