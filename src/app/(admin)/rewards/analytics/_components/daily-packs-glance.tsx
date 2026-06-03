import { Gift, PackageOpen, Users, Coins } from "lucide-react";
import { KpiTile } from "@/components/modern-panels";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery } from "@/lib/errors/safe-query";
import { getDailyPacksGiveaway } from "@/lib/queries/insights-rewards/daily-packs";
import { type InsightsRewardsPeriod } from "@/lib/queries/insights-rewards/_period";
import { type RewardsPeriod } from "@/lib/queries/rewards-analytics";

/**
 * Page-level daily-packs giveaway glance box on /rewards/analytics.
 *
 * A compact, always-visible KPI strip pinned above the category tab
 * switch so the daily-pack giveaway cost is readable at a glance no
 * matter which tab is active — the same "today-cost box" affordance the
 * dashboard pins at the top of the page. The full per-pack breakdown,
 * cost summary and curve still live in the dedicated Daily Packs tab
 * (commit fcd4692); this box is the quick-glance headline only.
 *
 * Reconciles 1:1 with that tab: it reads the SAME canonical
 * `getDailyPacksGiveaway` query through the SAME RewardsPeriod →
 * InsightsRewardsPeriod mapping the tab uses, so the headline figure
 * here and in the tab are byte-identical. The query is `unstable_cache`'d
 * keyed on (period, blacklist), so when the Daily Packs tab is the active
 * tab this box dedupes against the tab's fetch and adds ~no extra DB
 * cost; on any other tab it is a single cached read.
 *
 * House-POV (CLAUDE.md): the giveaway cost is the worth of free cards the
 * house hands users → money we give away → ROSE. The headline matches
 * what the tab leads with: `giveawayPayout` (cards out), NOT the
 * net-of-wager figure — the near-zero wager those opens collect already
 * flows through the `pack_opening` ledger into GGR. Counts (opens,
 * claimers) are neutral → blue.
 *
 * Streamed behind its own <Suspense> on the page with a small skeleton,
 * and the fetch is wrapped in `safeQuery` + `TileErrorFallback` so a slow
 * or throwing query degrades just this box, never the tabs or the page.
 */

/**
 * Map the rewards-analytics period union onto the closest
 * `InsightsRewardsPeriod` accepted by `getDailyPacksGiveaway`. Kept
 * identical to the mapping in `daily-packs-tab.tsx` on purpose: the box
 * and the tab must hit the exact same cache key for the exact same
 * period so their numbers always reconcile.
 */
function rewardsPeriodToInsightsPeriod(
  p: RewardsPeriod,
): InsightsRewardsPeriod {
  switch (p) {
    case "today":
      return "24h";
    case "7d":
      return "7d";
    case "30d":
      return "30d";
    case "all":
      return "all";
  }
}

export async function DailyPacksGlance({
  period,
  periodLabel,
}: {
  period: RewardsPeriod;
  periodLabel: string;
}) {
  const insightsPeriod = rewardsPeriodToInsightsPeriod(period);
  const { data, error } = await safeQuery(
    () => getDailyPacksGiveaway(insightsPeriod),
    null,
    "rewards-analytics.dailyPacksGlance",
  );

  if (error || !data) {
    return (
      <TileErrorFallback
        label="Daily-pack giveaway"
        hint="The daily-pack giveaway query failed. Server logs hold the digest."
      />
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <KpiTile
        label="Daily-pack giveaway"
        value={formatCurrency(data.giveawayPayout)}
        sub={`Cards given away · ${periodLabel}`}
        icon={Gift}
        accent="rose"
      />
      <KpiTile
        label="Daily packs opened"
        value={formatNumber(data.opens)}
        sub={`${formatNumber(data.cards)} cards out`}
        icon={PackageOpen}
        accent="blue"
      />
      <KpiTile
        label="Distinct claimers"
        value={formatNumber(data.claimers)}
        sub="Users who opened a free pack"
        icon={Users}
        accent="blue"
      />
      <KpiTile
        label="Avg cost / pack"
        value={formatCurrency(data.avgCostPerPack)}
        sub="Giveaway value per open"
        icon={Coins}
        accent="rose"
      />
    </div>
  );
}
