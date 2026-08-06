import { Suspense } from "react";
import Link from "next/link";
import {
  CloudRain,
  Target,
  Sparkles,
  Percent,
  Ticket,
  Trophy,
  Coins,
  TrendingUp,
  Users,
  Settings,
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  TableSkeleton,
  PaginationSkeleton,
  KpiStripSkeleton,
} from "@/components/loading-skeletons";
import { cn } from "@/lib/utils";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { LinkPendingShell } from "@/components/ux";
import { RainTab } from "./rain-tab";
import { ChallengesTab } from "./challenges-tab";
import { XpSalesTab } from "./xp-sales-tab";
import { RakebackTab } from "./rakeback-tab";
import { PromoCodesTab } from "./promo-codes-tab";
import { LeaderboardsTab } from "./leaderboards-tab";
import { DepositBonusTab } from "./deposit-bonus-tab";
import { LevelUpTab } from "./level-up-tab";
import { AffiliateTab } from "./affiliate-tab";
import { SettingsTab } from "./settings-tab";

export const metadata = { title: "Rewards" };

const TABS = [
  { value: "rain", label: "Rain", icon: CloudRain },
  { value: "challenges", label: "Challenges", icon: Target },
  { value: "xp-sales", label: "XP Sales", icon: Sparkles },
  { value: "rakeback", label: "Rakeback", icon: Percent },
  { value: "promo-codes", label: "Promo Codes", icon: Ticket },
  { value: "leaderboards", label: "Leaderboards", icon: Trophy },
  { value: "deposit-bonus", label: "Deposit Bonus", icon: Coins },
  { value: "level-up", label: "Level Up", icon: TrendingUp },
  { value: "affiliate", label: "Affiliate", icon: Users },
  { value: "settings", label: "Settings", icon: Settings },
] as const;

type TabValue = (typeof TABS)[number]["value"];

// The active tab's fallback SHAPE — a table-shaped skeleton jumps when the tab
// leads with a KPI strip / config cards / a chart instead of a table. These
// tabs open on KPI tiles or stacked config cards, so they get a KPI-strip
// skeleton; every other tab leads with a table + pagination.
const KPI_SHAPED_TABS = new Set<TabValue>([
  "xp-sales",
  "deposit-bonus",
  "affiliate",
  "settings",
]);

function TabFallback({ tab }: { tab: TabValue }) {
  if (KPI_SHAPED_TABS.has(tab)) {
    return (
      <div className="space-y-6">
        <KpiStripSkeleton count={4} />
        <KpiStripSkeleton count={2} />
      </div>
    );
  }
  return (
    <>
      <TableSkeleton rows={12} columns={tab === "rain" ? 9 : 7} />
      <PaginationSkeleton />
    </>
  );
}

export default async function RewardsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rewards");
  const params = await searchParams;
  const tab: TabValue = (TABS.find((t) => t.value === params.tab) ?? TABS[0])
    .value;

  return (
    <div className="space-y-6">
      <PageHero>
        <PageHeroIdentity />
      </PageHero>

      <div className="space-y-4">
        <div className="-mx-1 overflow-x-auto px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="inline-flex gap-1 rounded-lg border bg-muted/50 p-1">
            {TABS.map((t) => (
              <Link
                key={t.value}
                href={`/rewards?tab=${t.value}`}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                  tab === t.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <t.icon className="size-4" aria-hidden />
                <LinkPendingShell spinnerSize={13}>
                  {t.label}
                </LinkPendingShell>
              </Link>
            ))}
          </div>
        </div>

        {/* Active-tab-only: only the selected tab's data component is rendered
            and awaited. Switching tabs is a `?tab=` navigation that swaps the
            child under a keyed Suspense boundary — the hidden tab never fires
            its queries on first paint (CLAUDE.md Active-Timeframe-Only). */}
        <Suspense key={tab} fallback={<TabFallback tab={tab} />}>
          {tab === "rain" && <RainTab params={params} />}
          {tab === "challenges" && <ChallengesTab params={params} />}
          {tab === "xp-sales" && <XpSalesTab params={params} />}
          {tab === "rakeback" && <RakebackTab params={params} />}
          {tab === "promo-codes" && <PromoCodesTab params={params} />}
          {tab === "leaderboards" && <LeaderboardsTab params={params} />}
          {tab === "deposit-bonus" && <DepositBonusTab params={params} />}
          {tab === "level-up" && <LevelUpTab params={params} />}
          {tab === "affiliate" && <AffiliateTab />}
          {tab === "settings" && <SettingsTab />}
        </Suspense>
      </div>
    </div>
  );
}
