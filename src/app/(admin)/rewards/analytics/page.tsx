import { Suspense } from "react";
import { Gift } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  PageHero,
  PageHeroIdentity,
} from "@/components/modern-panels";
import {
  type RewardsPeriod,
  parseRewardsPeriod,
} from "@/lib/queries/rewards-analytics";
import { RewardsPeriodFilter } from "./period-filter";
import { RewardsAnalyticsTabSwitch } from "./_components/rewards-analytics-tab-switch";
import {
  RewardsAnalyticsTabSkeleton,
  OverviewTabSkeleton,
} from "./_components/tab-skeleton";
import { OverviewTab } from "./_components/overview-tab";
import { DepositBonusTab } from "./_components/deposit-bonus-tab";
import { RakebackTab } from "./_components/rakeback-tab";
import { RaceTab } from "./_components/race-tab";
import { AffiliateTab } from "./_components/affiliate-tab";
import { SignupTab } from "./_components/signup-tab";

export const metadata = { title: "Rewards Analytics" };

type Category =
  | "overview"
  | "deposit-bonus"
  | "rakeback"
  | "race"
  | "affiliate"
  | "signup";

function parseCategory(value: string | undefined): Category {
  switch (value) {
    case "deposit-bonus":
    case "rakeback":
    case "race":
    case "affiliate":
    case "signup":
      return value;
    default:
      return "overview";
  }
}

function periodLabel(p: RewardsPeriod): string {
  switch (p) {
    case "today":
      return "Last 24 hours";
    case "7d":
      return "Last 7 days";
    case "30d":
      return "Last 30 days";
    case "all":
      return "All time";
  }
}

/**
 * /rewards/analytics — tabbed deep-stats hub for every reward
 * category the house funds.
 *
 * Top-level shell:
 *   - PageHero with the period filter as the action slot.
 *   - Tab switch (Overview / Deposit Bonus / Rakeback / Race /
 *     Affiliate / Sign Up) immediately below the hero.
 *   - Suspense-wrapped tab content keyed on the active category so
 *     flipping tabs shows a skeleton instead of stale numbers from
 *     the previous category.
 *
 * Each tab is its own async server component that fetches its own
 * data. The category-specific helpers in
 * `rewards-category-analytics.ts` cache per (period, blacklist)
 * with a 60s revalidate + the `rewards-analytics` tag so the
 * round-trip stays cheap as admins flip categories.
 *
 * House-POV everywhere: every category is money the house GIVES
 * users, so all amounts render rose by design.
 */
export default async function RewardsAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rewards/analytics");
  const params = await searchParams;
  const period = parseRewardsPeriod(params.period);
  const category = parseCategory(params.category);
  const label = periodLabel(period);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={Gift}
            accent="rose"
            title="Rewards Analytics"
            subtitle="Every reward payout the house funds — bonuses, rakeback, affiliate, prizes & more."
          />
          <RewardsPeriodFilter />
        </div>
      </PageHero>

      {/* Category tabs — URL-driven, preserve period across swaps. */}
      <RewardsAnalyticsTabSwitch />

      {/* Suspense keyed on the active category so the skeleton renders
          on every flip — Next 15 reuses the previous render otherwise.
          Each tab is its own async server component that runs its own
          fetches. */}
      <Suspense
        key={category}
        fallback={
          category === "overview" ? (
            <OverviewTabSkeleton />
          ) : (
            <RewardsAnalyticsTabSkeleton />
          )
        }
      >
        {category === "overview" && <OverviewTab period={period} />}
        {category === "deposit-bonus" && (
          <DepositBonusTab period={period} periodLabel={label} />
        )}
        {category === "rakeback" && (
          <RakebackTab period={period} periodLabel={label} />
        )}
        {category === "race" && (
          <RaceTab period={period} periodLabel={label} />
        )}
        {category === "affiliate" && (
          <AffiliateTab period={period} periodLabel={label} />
        )}
        {category === "signup" && (
          <SignupTab period={period} periodLabel={label} />
        )}
      </Suspense>
    </div>
  );
}
