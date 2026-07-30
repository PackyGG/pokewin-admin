import { Suspense } from "react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { getDiscordNotificationConfig } from "@/lib/discord-notifications/config";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { PanelErrorBoundary } from "../_components/panel-error-boundary";
import { DiscordRoutingWorkspace } from "./routing-workspace";

export const metadata = { title: "Discord Routing · Antifraud" };

export default async function DiscordRoutingPage() {
  await requireAntifraudManagerPage();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <Suspense fallback={<WorkspaceSkeleton />}>
        <DiscordRoutingData />
      </Suspense>
    </div>
  );
}

async function DiscordRoutingData() {
  // The workspace is a ~1.2k-line client island driving every routing rule, so
  // an isolated render fault there must degrade to a panel rather than take the
  // whole route to the segment error boundary.
  try {
    const config = await getDiscordNotificationConfig();
    return (
      <PanelErrorBoundary label="Discord routing">
        <DiscordRoutingWorkspace initialConfig={config} />
      </PanelErrorBoundary>
    );
  } catch (error) {
    console.error("[discord-routing] config read failed:", error);
    return (
      <PanelErrorBoundary label="Discord routing">
        <DiscordRoutingWorkspace initialConfig={null} />
      </PanelErrorBoundary>
    );
  }
}

function WorkspaceSkeleton() {
  return (
    <div className="space-y-4" aria-label="Loading Discord routing">
      <Skeleton className="h-16 rounded-xl" />
      <Skeleton className="h-[420px] rounded-xl" />
    </div>
  );
}
