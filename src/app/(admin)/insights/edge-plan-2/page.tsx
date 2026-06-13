import { Suspense } from "react";
import { Sparkles } from "lucide-react";

import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { insightsRewardsPeriodLabel } from "@/lib/queries/insights-rewards/_period";

import { EDGE_PLAN_LIFETIME_LABEL, EDGE_PLAN_V2_PERIOD } from "./_baseline-v2";
import { EdgePlanV2Content } from "./_content";
import { EdgePlanV2Skeleton } from "./loading";

export const metadata = { title: "Edge Plan 2.0" };

export default async function EdgePlanV2Page() {
  await requirePageAccess("/insights/edge-plan-2");

  return (
    <div className="w-full min-w-0 space-y-4">
      <PageHero>
        <PageHeroIdentity
          icon={Sparkles}
          accent="purple"
          title="Edge Plan 2.0"
          subtitle="Real-data house-edge planner — gross→net edge after rewards (rakeback, affiliate, raffles, deposit bonus, races, packs). Full-width command center on real production data."
        />
      </PageHero>

      <p className="text-xs text-muted-foreground">
        Baseline window:{" "}
        <span className="font-medium text-foreground">
          {insightsRewardsPeriodLabel(EDGE_PLAN_V2_PERIOD)}
        </span>{" "}
        (planner &amp; levers). The owner-trusted headline strip shows{" "}
        <span className="font-medium text-foreground">
          {EDGE_PLAN_LIFETIME_LABEL}
        </span>
        . Read-only planning — save configs in-browser to compare scenarios.
      </p>

      <Suspense fallback={<EdgePlanV2Skeleton />}>
        <EdgePlanV2Content />
      </Suspense>
    </div>
  );
}
