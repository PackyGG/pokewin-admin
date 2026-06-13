import { Suspense } from "react";
import { Hourglass } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import {
  KpiStripSkeleton,
  StatPanelSkeleton,
} from "@/components/loading-skeletons";
import {
  parseInsightsRewardsPeriod,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { ExpiryPeriodFilter } from "./_components/period-filter";
import { ExpiryContent } from "./_components/expiry-content";

export const metadata = { title: "Reward Expiry" };

/**
 * /insights/rewards/expiry — reward-expiry at-risk / lost (RAKEBACK MVP).
 *
 * The brief was an at-risk / lost-unclaimed view from
 * `rakeback_claims.claimed_at IS NULL`. Verified against live prod
 * (2026-06-14): every claim row has `claimed_at` set — pending rakeback
 * is computed live and never persisted, so "unclaimed expiry $" cannot be
 * measured from stored data. The page is scoped to what IS truthful:
 *
 *   1. A prominent model-gap notice (no fabricated at-risk/lost numbers).
 *   2. The live per-type claim windows (rakeback_config.expiration_days).
 *   3. A behavioural "forfeited by lapsing" proxy from the claim history
 *      that does exist.
 *
 * Active-timeframe-only: a single `<Suspense key={period}>` boundary —
 * only the active window's cohort query fires; flipping the period
 * re-renders the skeleton. The expiry-config panel is window-independent.
 *
 * House-POV colour: forfeited rakeback is a program-effectiveness signal,
 * not a profit line → amber/neutral (see expiry.ts header for the full
 * rationale).
 */
export default async function RewardExpiryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/rewards/expiry");
  const params = await searchParams;
  const period = parseInsightsRewardsPeriod(params.period);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={Hourglass}
            accent="amber"
            title="Reward Expiry"
            subtitle="Rakeback-scoped MVP: live claim windows + value forfeited when claimants lapse. Unclaimed-expiry $ is live-computed by the backend and not stored — see the notice below."
          />
          <div className="flex flex-wrap items-center gap-2">
            <ExpiryPeriodFilter />
          </div>
        </div>
      </PageHero>

      <Suspense key={period} fallback={<ExpirySkeleton />}>
        <ExpiryContent period={period as InsightsRewardsPeriod} />
      </Suspense>
    </div>
  );
}

function ExpirySkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-24 rounded-2xl border border-amber-500/30 bg-amber-500/10" />
      <div className="grid gap-3 sm:grid-cols-3">
        <StatPanelSkeleton />
        <StatPanelSkeleton />
        <StatPanelSkeleton />
      </div>
      <KpiStripSkeleton count={3} />
    </div>
  );
}
