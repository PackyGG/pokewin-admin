import {
  Gift,
  PackageOpen,
  Users,
  Coins,
  Layers,
  TrendingDown,
  LineChart as LineChartIcon,
} from "lucide-react";
import {
  SectionHeading,
  KpiTile,
  StatPanel,
  PanelRow,
} from "@/components/modern-panels";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import { AnimatedNumber } from "@/components/animated-number";
import { TileErrorFallback } from "@/components/tile-error-fallback";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { safeQuery, REWARD_QUERY_TIMEOUT_MS } from "@/lib/errors/safe-query";
import {
  getDailyPacksGiveaway,
  type DailyPackRow,
} from "@/lib/queries/insights-rewards/daily-packs";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { ForecastLineChart } from "./forecast-line-chart";

/**
 * Daily Packs tab on /insights/rewards.
 *
 * Daily / free packs (`packs.pack_type = 'reward'`) are a ~$0-wager
 * giveaway where the user still wins real cards — a pure house cost the
 * gaming edge deliberately excludes and that no reward surface counted
 * until now. This tab makes that cost visible.
 *
 * House-POV: every card the house hands out for free is money we give
 * users → rose throughout. The headline figure is the value of cards
 * given away (the giveaway cost); the (near-zero) wager those opens
 * collected is shown as a reconciling line, not netted into the headline.
 */
export async function DailyPacksTab({
  period,
}: {
  period: InsightsRewardsPeriod;
}) {
  const { data, error } = await safeQuery(
    () => getDailyPacksGiveaway(period),
    null,
    "insights-rewards.dailyPacks",
    REWARD_QUERY_TIMEOUT_MS,
  );
  if (error || !data) {
    return (
      <TileErrorFallback
        label="Rewards — Daily Packs"
        hint="The daily-pack giveaway query failed. Server logs hold the digest."
        size="panel"
      />
    );
  }

  const label = insightsRewardsPeriodLabel(period);

  if (data.opens === 0 && data.giveawayPayout === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Gift}
          title={`No daily packs opened in ${label.toLowerCase()}`}
          description="No free / daily reward packs were opened in this window. Try a longer period."
          compact
        />
      </div>
    );
  }

  // Net of the near-zero wager those opens collected. Shown as a
  // reconciling detail only — when a reward pack was somehow charged
  // (a rare data artefact) the net can dip below the gross giveaway.
  const netIsHouseCost = data.netCost >= 0;

  return (
    <div className="space-y-6">
      {/* Headline KPI strip — giveaway cost (rose), opens, claimers,
          avg cost / pack, cards handed out. */}
      <FadeIn>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <KpiTile
            label="Giveaway cost"
            value={formatCurrency(data.giveawayPayout)}
            sub={`Cards given away · ${label}`}
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
          <KpiTile
            label="Cards handed out"
            value={formatNumber(data.cards)}
            sub="From free / daily packs"
            icon={Layers}
            accent="rose"
          />
        </div>
      </FadeIn>

      {/* Cost summary panel + per-pack breakdown side-by-side. */}
      <FadeIn>
        <div className="grid gap-4 xl:grid-cols-2">
          <div>
            <SectionHeading icon={TrendingDown} title="Giveaway cost summary" />
            <div className="mt-3">
              <StatPanel
                title="Daily-pack giveaway cost"
                icon={Gift}
                accent="rose"
              >
                <p className="text-2xl font-bold leading-tight tracking-tight tabular-nums text-rose-600 dark:text-rose-400 sm:text-3xl">
                  <AnimatedNumber
                    value={data.giveawayPayout}
                    format="currency"
                    duration={700}
                  />
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatNumber(data.opens)}{" "}
                  {data.opens === 1 ? "pack" : "packs"} opened ·{" "}
                  {formatNumber(data.claimers)} claimers · {label}
                </p>
                <div className="mt-3 space-y-1 border-t pt-3">
                  <PanelRow
                    label="Cards given away (cost)"
                    value={formatCurrency(data.giveawayPayout)}
                    valueClassName="text-rose-600 dark:text-rose-400"
                  />
                  <PanelRow
                    label="Wager collected on opens"
                    value={formatCurrency(data.wager)}
                    valueClassName="text-emerald-600 dark:text-emerald-400"
                  />
                  <PanelRow
                    label="Net cost (after wager)"
                    value={`${netIsHouseCost ? "" : "+"}${formatCurrency(data.netCost)}`}
                    valueClassName={
                      netIsHouseCost
                        ? "text-rose-600 dark:text-rose-400"
                        : "text-emerald-600 dark:text-emerald-400"
                    }
                  />
                  <PanelRow
                    label="Cards handed out"
                    value={formatNumber(data.cards)}
                  />
                  <PanelRow
                    label="Avg cost per pack"
                    value={formatCurrency(data.avgCostPerPack)}
                  />
                </div>
              </StatPanel>
            </div>
          </div>

          <div>
            <SectionHeading icon={Layers} title="Cost by pack" />
            <div className="mt-3">
              <PerPackBreakdown
                packs={data.packs}
                grandTotal={data.giveawayPayout}
              />
            </div>
          </div>
        </div>
      </FadeIn>

      {/* Daily giveaway-cost curve — rose area, same chart family as the
          rest of the rewards-insights surface. */}
      <FadeIn>
        <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70 p-4 sm:p-5">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-rose-500/[0.08] blur-2xl"
          />
          <div className="relative">
            <SectionHeading
              icon={LineChartIcon}
              title={`Daily giveaway cost — ${label}`}
            />
            <div className="mt-3">
              <ForecastLineChart data={data.dailySeries} height={260} />
            </div>
          </div>
        </div>
      </FadeIn>
    </div>
  );
}

// ─── Per-pack breakdown ─────────────────────────────────────────────

/**
 * One row per reward pack (e.g. Daily Tier 1 / Daily Tier 10) with a
 * share bar of its giveaway cost vs the total. House-POV rose bars.
 */
function PerPackBreakdown({
  packs,
  grandTotal,
}: {
  packs: DailyPackRow[];
  grandTotal: number;
}) {
  const withCost = packs.filter((p) => p.giveawayPayout > 0 || p.opens > 0);
  if (withCost.length === 0) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={Layers}
          title="No pack-level activity"
          description="No reward packs were opened in the selected period."
          compact
        />
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-2xl border bg-card p-4 sm:p-5">
      {withCost.map((pack) => {
        const share =
          grandTotal > 0 ? (pack.giveawayPayout / grandTotal) * 100 : 0;
        return (
          <div key={pack.packId} className="rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium">
                  {pack.name}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  · {formatNumber(pack.opens)} opens
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  · {formatNumber(pack.claimers)} users
                </span>
              </div>
              <span className="shrink-0 text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(pack.giveawayPayout)}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <div className="h-2 flex-1 overflow-hidden rounded-sm bg-muted">
                <div
                  className="h-full rounded-sm bg-rose-500/60 transition-all"
                  style={{ width: `${share}%` }}
                />
              </div>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {share.toFixed(1)}%
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
