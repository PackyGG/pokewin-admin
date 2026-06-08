import { Suspense } from "react";
import { Sparkles } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import {
  parseInsightsRewardsPeriod,
  insightsRewardsPeriodLabel,
} from "@/lib/queries/insights-rewards/_period";

import { EdgePlanV2PeriodFilter } from "./_period-filter";
import { EdgePlanV2Content } from "./_content";
import { EdgePlanV2Skeleton } from "./loading";

export const metadata = { title: "Edge Plan 2.0" };

export default async function EdgePlanV2Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/edge-plan-2");
  const params = await searchParams;
  const period = parseInsightsRewardsPeriod(params.period);

  return (
    <div className="w-full min-w-0 space-y-4">
      <PageHero>
        <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between">
          <PageHeroIdentity
            icon={Sparkles}
            accent="purple"
            title="Edge Plan 2.0"
            subtitle="Post-raffle economics — shards earn/spend, balance withdrawals, wager rules. Full-width command center on real production data."
          />
          <EdgePlanV2PeriodFilter />
        </div>
      </PageHero>

      <p className="text-xs text-muted-foreground">
        Baseline window:{" "}
        <span className="font-medium text-foreground">
          {insightsRewardsPeriodLabel(period)}
        </span>
        . Read-only planning — no live writes.
      </p>

      <Suspense key={period} fallback={<EdgePlanV2Skeleton />}>
        <EdgePlanV2Content period={period} />
      </Suspense>
    </div>
  );
}
