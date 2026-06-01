import { Joystick } from "lucide-react";
import { Suspense } from "react";
import { requirePageAccess } from "@/lib/dal";
import { PageHero, PageHeroIdentity } from "@/components/modern-panels";
import { GamesTabNav } from "./tab-nav";
import { GamesPeriodFilter } from "./period-filter";
import { parseGamesTab } from "./types";
import { parseGamesPeriod } from "@/lib/queries/insights-games/_shared";
import { OverviewTab } from "./tab-overview";
import { PacksTab } from "./tab-packs";
import { BattlesTab } from "./tab-battles";
import { UpgraderTab } from "./tab-upgrader";
import { BorrowTab } from "./tab-borrow";
import { UsersTab } from "./tab-users";
import { TabSkeleton } from "../../analytics/tab-skeleton";

export const metadata = { title: "Games — Insights" };

/**
 * /insights/games — deep per-game P&L surface.
 *
 * Every figure on the page is borrow-corrected (user-paid only, not
 * the borrowed leg) and creator-on-stream-excluded (creator
 * sponsored play during a deal session drops on both wager and
 * payout sides). This matches the GGR fix in commit 7390363 and the
 * analytics/pure-pnl semantics — so the headline numbers on the
 * dashboard / analytics / insights line up.
 *
 * Each tab is its own async Suspense segment so a deep link only
 * pays for the data its tab needs.
 */
export default async function GamesInsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/insights/games");
  const params = await searchParams;
  const period = parseGamesPeriod(params.period);
  const tab = parseGamesTab(params.tab);

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <PageHeroIdentity
            icon={Joystick}
            title="Games"
            subtitle="Per-game P&L · borrow-corrected wagers · creator-stream play excluded"
            accent="cyan"
          />
          <GamesPeriodFilter />
        </div>
      </PageHero>

      <GamesTabNav />

      {/* Per-tab Suspense — keyed by tab + period so toggles trigger
          a fresh fetch + skeleton instead of stale content lingering
          while the new tab loads. */}
      <Suspense key={`${tab}-${period}`} fallback={<TabSkeleton />}>
        {tab === "overview" && <OverviewTab period={period} />}
        {tab === "packs" && <PacksTab period={period} />}
        {tab === "battles" && <BattlesTab period={period} />}
        {tab === "upgrader" && <UpgraderTab period={period} />}
        {tab === "borrow" && <BorrowTab period={period} />}
        {tab === "users" && <UsersTab period={period} />}
      </Suspense>
    </div>
  );
}
