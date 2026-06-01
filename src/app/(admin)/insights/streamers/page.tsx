import { Tv } from "lucide-react";
import { Suspense } from "react";
import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { ExportButton } from "@/components/export-button";
import { PeriodFilter } from "./period-filter";
import { StreamersTabNav } from "./tab-nav";
import { parsePeriod, parseTab } from "./types";
import { OverviewTab } from "./tab-overview";
import { MoneyMakersTab } from "./tab-money-makers";
import { SusTab } from "./tab-sus";
import { CodeSwitchingTab } from "./tab-code-switching";
import { LeaderboardSnipingTab } from "./tab-leaderboard-sniping";
import { RoiTab } from "./tab-roi";
import { TabSkeleton } from "./tab-skeleton";

export const metadata = { title: "Streamer Insights" };

/**
 * /insights/streamers — per-creator deep insights, abuse detection,
 * sus-behaviour signals, and money-maker rankings.
 *
 * Tabs:
 *   1. Overview            — every creator, ranked by net house P&L
 *   2. Money Makers        — top 25 net contributors
 *   3. Sus / Abuse         — risk-scored creators with signal breakdown
 *   4. Code Switching      — users with multi-code history (per-user view)
 *   5. Leaderboard Snipers — race winners cross-referenced with code-switching
 *   6. Affiliate ROI       — house P&L / commission, ranked
 *
 * Surface gates on /insights/streamers — granted via the standard role
 * editor.
 */

export default async function StreamerInsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/streamers");
  const params = await searchParams;
  const period = parsePeriod(params.period);
  const tab = parseTab(params.tab);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={Tv}
            title="Streamers"
            subtitle="Per-creator deep insights, abuse detection, sus behaviour signals, money-makers"
            accent="purple"
          />
          <div className="flex flex-wrap items-center gap-2">
            <PeriodFilter />
            <ExportButton page="streamers" params={{ period }} />
          </div>
        </div>
      </PageHero>

      <StreamersTabNav />

      {/* Each tab is an independent Suspense'd segment — only the
          active one fetches data. Several of these tabs run heavy
          aggregates (the overview alone walks the entire affiliate_
          code_usages + balance + cardWD chain). The shared cache key
          across overview/money-makers/roi means tab switches between
          them are effectively free after the first render. */}
      <Suspense key={`${tab}-${period}`} fallback={<TabSkeleton />}>
        {tab === "overview" && <OverviewTab period={period} />}
        {tab === "money-makers" && <MoneyMakersTab period={period} />}
        {tab === "sus" && <SusTab period={period} />}
        {tab === "code-switching" && <CodeSwitchingTab period={period} />}
        {tab === "leaderboard-snipers" && (
          <LeaderboardSnipingTab period={period} />
        )}
        {tab === "roi" && <RoiTab period={period} />}
      </Suspense>
    </div>
  );
}
