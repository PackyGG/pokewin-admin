import { Suspense } from "react";
import { Webhook } from "lucide-react";

import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { Skeleton } from "@/components/ui/skeleton";
import { getDiscordNotificationConfig } from "@/lib/discord-notifications/config";
import { requireAntifraudManagerPage } from "@/lib/require-antifraud-access";
import { DiscordRoutingWorkspace } from "./routing-workspace";

export const metadata = { title: "Discord Routing · Antifraud" };

export default async function WebhooksPage() {
  await requireAntifraudManagerPage();

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity
          icon={Webhook}
          accent="cyan"
          title="Discord Routing"
          subtitle="Send antifraud events through the bot instead of fixed webhooks"
        />
      </PageHero>

      <Suspense fallback={<WorkspaceSkeleton />}>
        <DiscordRoutingData />
      </Suspense>
    </div>
  );
}

async function DiscordRoutingData() {
  try {
    const config = await getDiscordNotificationConfig();
    return <DiscordRoutingWorkspace initialConfig={config} />;
  } catch (error) {
    console.error("[discord-routing] config read failed:", error);
    return <DiscordRoutingWorkspace initialConfig={null} />;
  }
}

function WorkspaceSkeleton() {
  return (
    <div className="space-y-4" aria-label="Loading Discord routing">
      <div className="grid gap-3 sm:grid-cols-3">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-24 rounded-xl" />
      </div>
      <Skeleton className="h-16 rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.45fr)]">
        <Skeleton className="h-[520px] rounded-xl" />
        <Skeleton className="h-[520px] rounded-xl" />
      </div>
    </div>
  );
}
