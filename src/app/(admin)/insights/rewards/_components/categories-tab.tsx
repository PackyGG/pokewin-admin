import { Layers } from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import { DepositBonusTab } from "@/app/(admin)/rewards/analytics/_components/deposit-bonus-tab";
import { RakebackTab } from "@/app/(admin)/rewards/analytics/_components/rakeback-tab";
import { RaceTab } from "@/app/(admin)/rewards/analytics/_components/race-tab";
import { AffiliateTab } from "@/app/(admin)/rewards/analytics/_components/affiliate-tab";
import { SignupTab } from "@/app/(admin)/rewards/analytics/_components/signup-tab";
import {
  insightsPeriodToCategoryPeriod,
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";

/**
 * Categories tab on /insights/rewards. Subsumes every category from
 * /rewards/analytics into a single scrollable page so admins can scan
 * all five deep-dives without flipping URL tabs:
 *
 *   - Deposit Bonus  (cohort lens, cap-hit analysis, top cap deposits)
 *   - Rakeback       (rate distribution, type spread, cadence)
 *   - Race           (budget usage, position spread, repeat winners)
 *   - Affiliate      (downstream wager, distinct referred, inactive)
 *   - Sign Up        (cohort retention, source distribution, funnel)
 *
 * Each block reuses the EXISTING server-component tab from
 * /rewards/analytics — no duplication. The /insights page maps its
 * wider period set onto the closest supported `RewardsPeriod` via
 * `insightsPeriodToCategoryPeriod` so numbers reconcile with what an
 * admin would see on /rewards/analytics for the same window.
 *
 * 3d → 7d and 90d → 30d (the per-category helpers don't expose 3d
 * or 90d cache keys); 24h / 7d / 30d / all map 1:1.
 */
export async function CategoriesTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const categoryPeriod = insightsPeriodToCategoryPeriod(period);
  // Pull a friendly label from the categoryPeriod so each child tab
  // shows the EFFECTIVE window (e.g. an admin on 90d sees "Last 30
  // days" inside, matching what they'd see on /rewards/analytics).
  const labelByPeriod: Record<typeof categoryPeriod, string> = {
    today: "Last 24 hours",
    "7d": "Last 7 days",
    "30d": "Last 30 days",
    all: "All time",
  };
  const periodLabel = labelByPeriod[categoryPeriod];
  // Show a deliberate note when the page-level period maps onto a
  // narrower category period — admins shouldn't be surprised that
  // 90d → 30d category panels.
  const showRoundingNote =
    period === "3d" || period === "90d";

  return (
    <div className="space-y-10">
      <div className="space-y-3">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <SectionHeading icon={Layers} title="Per-category deep dive" />
        </div>
        {showRoundingNote && (
          <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <span>
              The page period is{" "}
              <span className="font-medium">
                {insightsRewardsPeriodLabel(period)}
              </span>
              . The per-category panels below use the closest supported
              window from the insights rewards rollup:{" "}
              <span className="font-medium">{periodLabel}</span>.
            </span>
          </div>
        )}
      </div>

      <DepositBonusTab period={categoryPeriod} periodLabel={periodLabel} />
      <div className="border-t" />
      <RakebackTab period={categoryPeriod} periodLabel={periodLabel} />
      <div className="border-t" />
      <RaceTab period={categoryPeriod} periodLabel={periodLabel} />
      <div className="border-t" />
      <AffiliateTab period={categoryPeriod} periodLabel={periodLabel} />
      <div className="border-t" />
      <SignupTab period={categoryPeriod} periodLabel={periodLabel} />
    </div>
  );
}
