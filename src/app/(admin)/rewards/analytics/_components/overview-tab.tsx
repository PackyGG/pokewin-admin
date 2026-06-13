import Link from "next/link";
import {
  Gift,
  TrendingDown,
  Percent,
  Share2,
  CloudRain,
  Sparkles,
  Hash,
  Users,
  PieChart,
  LineChart as LineChartIcon,
  Trophy,
  CalendarDays,
  CalendarRange,
  Crown,
  Wallet,
} from "lucide-react";
import {
  SectionHeading,
  KpiTile,
  StatPanel,
} from "@/components/modern-panels";
import { AnimatedNumber } from "@/components/animated-number";
import { FadeIn } from "@/components/fade-in";
import { EmptyState } from "@/components/empty-state";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate, formatNumber } from "@/lib/utils/format";
import {
  getRewardsAnalytics,
  getRewardCategoryBreakdown,
  type RewardsPeriod,
  type RewardCategoryKey,
  type RewardCategoryBreakdown,
  type RewardRecipientRow,
} from "@/lib/queries/rewards-analytics";
import {
  getRewardsLeaderboards,
  getLifetimePrizesBreakdown,
  getPrizeBudgetBreakdown,
  type RaceLeaderboardSummary,
} from "@/lib/queries/rewards-analytics-leaderboards";
import { RewardsCostChart } from "../rewards-chart";
import { RewardTileDrilldown } from "../reward-tile-popover";
import {
  LifetimePrizesPopover,
  PrizeBudgetPopover,
} from "../leaderboard-tile-popover";

/**
 * Overview tab on /rewards/analytics — the original cross-category
 * summary that lived on the page before it was split into tabs.
 * Renders:
 *
 *   - KPI strip (Total + 5 biggest categories) with per-tile
 *     drilldown popovers (per-ledger-type breakdown + lazy top
 *     recipients).
 *   - Daily reward-cost area chart.
 *   - Breakdown by reward type + reward cost summary side-by-side.
 *   - Platform leaderboards (lifetime prizes + per-race prize budget
 *     + daily + weekly race summaries).
 *   - Top reward recipients table.
 *
 * House-POV: rewards are money the house GIVES users → every amount
 * here renders rose by design.
 */

// Per-category icon for the breakdown panel below the chart. Accent
// stays rose for the cost tiles (House-POV), but the breakdown rows
// use neutral chrome with rose amounts.
const CATEGORY_ICONS: Record<RewardCategoryKey, React.ElementType> = {
  bonuses: Gift,
  rakeback: Percent,
  affiliate: Share2,
  rainRace: CloudRain,
  signupPack: Sparkles,
  waitlist: Hash,
  houseCredits: Wallet,
};

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

export async function OverviewTab({ period }: { period: RewardsPeriod }) {
  // Same parallel fetch shape that lived on the page pre-tabs — the
  // per-category breakdown queries hydrate the drilldown popovers so
  // the rows render immediately on click without a second round-trip.
  const [
    data,
    leaderboards,
    bonusesBreakdown,
    rakebackBreakdown,
    affiliateBreakdown,
    rainRaceBreakdown,
    signupPackBreakdown,
    waitlistBreakdown,
    houseCreditsBreakdown,
    lifetimePrizesBreakdown,
    prizeBudgetBreakdown,
  ] = await Promise.all([
    getRewardsAnalytics(period),
    getRewardsLeaderboards(),
    getRewardCategoryBreakdown(period, "bonuses"),
    getRewardCategoryBreakdown(period, "rakeback"),
    getRewardCategoryBreakdown(period, "affiliate"),
    getRewardCategoryBreakdown(period, "rainRace"),
    getRewardCategoryBreakdown(period, "signupPack"),
    getRewardCategoryBreakdown(period, "waitlist"),
    getRewardCategoryBreakdown(period, "houseCredits"),
    getLifetimePrizesBreakdown(),
    // Headline tile sums daily + weekly. Monthly would inflate the
    // breakdown without changing the headline, so it's deliberately
    // excluded from this call too.
    getPrizeBudgetBreakdown(["daily", "weekly"]),
  ]);

  const byKey = new Map(data.categories.map((c) => [c.key, c]));
  const breakdownByCategory: Record<RewardCategoryKey, RewardCategoryBreakdown> = {
    bonuses: bonusesBreakdown,
    rakeback: rakebackBreakdown,
    affiliate: affiliateBreakdown,
    rainRace: rainRaceBreakdown,
    signupPack: signupPackBreakdown,
    waitlist: waitlistBreakdown,
    houseCredits: houseCreditsBreakdown,
  };
  const kpiCategories: {
    key: RewardCategoryKey;
    label: string;
    icon: React.ElementType;
  }[] = [
    { key: "bonuses", label: "Bonuses & Promos", icon: Gift },
    { key: "rakeback", label: "Rakeback", icon: Percent },
    { key: "affiliate", label: "Affiliate", icon: Share2 },
    { key: "rainRace", label: "Rain / Race", icon: CloudRain },
    { key: "signupPack", label: "Signup Rewards", icon: Sparkles },
  ];
  // "Total Rewards" popover surfaces ONE row per CATEGORY (not per
  // ledger type) so the popover answers "which BUCKET drives the
  // total" — different shape from the per-tile popovers. Reuses the
  // RewardBreakdownRow type so it shares the popover renderer.
  const totalBreakdownRows = data.categories
    .filter((c) => c.total > 0)
    .map((c) => ({
      type: c.key,
      label: c.label,
      total: c.total,
      count: c.count,
    }));

  return (
    <div className="space-y-6">
      {/* KPI strip — all rose (house cost). Each tile has a drilldown
          info-icon. Total Rewards shows category rows; per-category
          tiles show ledger-type rows + lazy top recipients. Bonuses
          additionally surfaces the top 10 promo codes. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile
          label={`Total Rewards (${periodLabel(period)})`}
          value={formatCurrency(data.totalCost)}
          sub={`${formatNumber(data.totalCount)} payouts`}
          icon={TrendingDown}
          accent="rose"
          action={
            data.totalCost > 0 ? (
              <RewardTileDrilldown
                category="all"
                label={`All rewards (${periodLabel(period)})`}
                breakdownRows={totalBreakdownRows}
                total={data.totalCost}
                count={data.totalCount}
                periodParam={period}
                periodLabel={periodLabel(period)}
              />
            ) : undefined
          }
        />
        {kpiCategories.map(({ key, label, icon }) => {
          const cat = byKey.get(key);
          const total = cat?.total ?? 0;
          const share = cat?.share ?? 0;
          const breakdown = breakdownByCategory[key];
          return (
            <KpiTile
              key={key}
              label={label}
              value={formatCurrency(total)}
              sub={`${share.toFixed(1)}% of cost`}
              icon={icon}
              accent="rose"
              action={
                breakdown.total > 0 ? (
                  <RewardTileDrilldown
                    category={key}
                    label={label}
                    breakdownRows={breakdown.rows}
                    total={breakdown.total}
                    count={breakdown.count}
                    periodParam={period}
                    periodLabel={periodLabel(period)}
                  />
                ) : undefined
              }
            />
          );
        })}
      </div>

      {/* Time series — daily total reward cost. */}
      <FadeIn>
        <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70 p-4 sm:p-5">
          <div
            aria-hidden
            className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-rose-500/[0.08] blur-2xl"
          />
          <div className="relative">
            <SectionHeading
              icon={LineChartIcon}
              title={`Daily reward cost — ${periodLabel(period)}`}
            />
            <div className="mt-3">
              <RewardsCostChart daily={data.daily} />
            </div>
          </div>
        </div>
      </FadeIn>

      {/* Breakdown by type + summary side-by-side on wide screens.
          Both panels mirror the KPI strip's drilldown — each category
          row carries the same info-icon popover so admins can drill
          into per-type rows + recipient lists from this view too. */}
      <FadeIn>
        <div className="grid gap-4 xl:grid-cols-2">
          <div>
            <SectionHeading icon={PieChart} title="Breakdown by reward type" />
            <div className="mt-3">
              <RewardBreakdownPanel
                categories={data.categories}
                totalCost={data.totalCost}
                breakdownByCategory={breakdownByCategory}
                periodParam={period}
                periodLabel={periodLabel(period)}
              />
            </div>
          </div>

          <div>
            <SectionHeading icon={Hash} title="Reward cost summary" />
            <div className="mt-3">
              <StatPanel title="Total reward cost" icon={TrendingDown} accent="rose">
                <p className="text-2xl font-bold leading-tight tracking-tight tabular-nums text-rose-600 dark:text-rose-400 sm:text-3xl">
                  <AnimatedNumber
                    value={data.totalCost}
                    format="currency"
                    duration={700}
                  />
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatNumber(data.totalCount)} reward payouts ·{" "}
                  {periodLabel(period)}
                </p>
                <div className="mt-3 space-y-0.5 border-t pt-3">
                  {data.categories.map((c) => {
                    const cb = breakdownByCategory[c.key];
                    return (
                      <div
                        key={c.key}
                        className="flex items-center justify-between gap-3 py-1 text-sm"
                      >
                        <span className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground">
                          <span className="truncate">{c.label}</span>
                          <span className="shrink-0 text-muted-foreground/60 tabular-nums">
                            · {formatNumber(c.count)}
                          </span>
                          {cb.total > 0 && (
                            <RewardTileDrilldown
                              category={c.key}
                              label={c.label}
                              breakdownRows={cb.rows}
                              total={cb.total}
                              count={cb.count}
                              periodParam={period}
                              periodLabel={periodLabel(period)}
                            />
                          )}
                        </span>
                        <span className="shrink-0 font-medium tabular-nums text-rose-600 dark:text-rose-400">
                          {formatCurrency(c.total)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </StatPanel>
            </div>
          </div>
        </div>
      </FadeIn>

      {/* Platform leaderboards — site-wide daily + weekly cash races
          (NOT per-creator affiliate leaderboards). Prize money flows
          OUT to users → rose accent per CLAUDE.md House-POV rule. */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading
            icon={Trophy}
            title="Platform leaderboards"
            action={
              <Link
                href="/rewards/leaderboards"
                className="text-xs font-medium text-muted-foreground hover:text-foreground"
              >
                Manage leaderboards →
              </Link>
            }
          />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <KpiTile
              label="Lifetime prizes paid"
              value={formatCurrency(leaderboards.lifetimePrizesPaid)}
              sub={`${formatNumber(leaderboards.lifetimeClaimsCount)} prize claims`}
              icon={Crown}
              accent="rose"
              action={
                lifetimePrizesBreakdown.total > 0 ? (
                  <LifetimePrizesPopover
                    byRaceType={lifetimePrizesBreakdown.byRaceType}
                    total={lifetimePrizesBreakdown.total}
                    claims={lifetimePrizesBreakdown.claims}
                  />
                ) : undefined
              }
            />
            <KpiTile
              label="Per-race prize budget"
              value={formatCurrency(
                leaderboards.daily.prizePool + leaderboards.weekly.prizePool,
              )}
              sub={`${leaderboards.daily.prizePositions + leaderboards.weekly.prizePositions} tiered positions (daily + weekly)`}
              icon={Trophy}
              accent="rose"
              action={
                prizeBudgetBreakdown.total > 0 ? (
                  <PrizeBudgetPopover
                    rows={prizeBudgetBreakdown.rows}
                    total={prizeBudgetBreakdown.total}
                  />
                ) : undefined
              }
            />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <LeaderboardPanel
              summary={leaderboards.daily}
              icon={CalendarDays}
              kindLabel="Daily race"
            />
            <LeaderboardPanel
              summary={leaderboards.weekly}
              icon={CalendarRange}
              kindLabel="Weekly race"
            />
          </div>
        </div>
      </FadeIn>

      {/* Top recipients. */}
      <FadeIn>
        <div className="space-y-3">
          <SectionHeading icon={Trophy} title="Top reward recipients" />
          <div className="surface-sheen relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <RecipientsTable rows={data.topRecipients} />
          </div>
        </div>
      </FadeIn>
    </div>
  );
}

/**
 * Single race-summary panel — header row with kind label + state
 * badge + period dates, hero prize pool, and a top-5 winners table.
 * Used twice on the overview tab (daily + weekly). All amounts render
 * rose because prize money is a house cost (money out to users) per
 * CLAUDE.md's House-POV rule.
 */
function LeaderboardPanel({
  summary,
  icon: Icon,
  kindLabel,
}: {
  summary: RaceLeaderboardSummary;
  icon: React.ElementType;
  kindLabel: string;
}) {
  const stateLabel =
    summary.state === "active"
      ? "Active"
      : summary.state === "ended"
        ? "Most recent"
        : "Not configured";
  const stateBadgeClasses =
    summary.state === "active"
      ? "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30"
      : summary.state === "ended"
        ? "bg-muted text-muted-foreground border-border"
        : "bg-muted/50 text-muted-foreground border-border";
  const periodRange =
    summary.periodStart && summary.periodEnd
      ? `${formatDate(summary.periodStart)} → ${formatDate(summary.periodEnd)}`
      : null;
  return (
    <StatPanel title={kindLabel} icon={Icon} accent="rose">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className={cn("text-[10px]", stateBadgeClasses)}>
          {stateLabel}
        </Badge>
        {periodRange && (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {periodRange}
          </span>
        )}
      </div>
      <p className="mt-2 text-2xl font-bold leading-tight tracking-tight tabular-nums text-rose-600 dark:text-rose-400 sm:text-3xl">
        <AnimatedNumber
          value={summary.prizePool}
          format="currency"
          duration={700}
        />
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Prize pool · {summary.prizePositions}{" "}
        {summary.prizePositions === 1 ? "position" : "positions"}
      </p>
      <div className="mt-3 border-t pt-3">
        <LeaderboardTopWinners summary={summary} />
      </div>
    </StatPanel>
  );
}

/**
 * Top-5 winners table for a race summary. Renders an inline mini-
 * table (rank, user, wagered, prize). Empty state when no claims /
 * snapshots exist yet. Prize column is rose to stay House-POV.
 */
function LeaderboardTopWinners({
  summary,
}: {
  summary: RaceLeaderboardSummary;
}) {
  if (summary.state === "none") {
    return (
      <EmptyState
        icon={Trophy}
        title="No race configured"
        description="Start a race on /rewards/leaderboards to populate this panel."
        compact
      />
    );
  }
  if (summary.topWinners.length === 0) {
    return (
      <EmptyState
        icon={Trophy}
        title={
          summary.state === "active"
            ? "No standings yet"
            : "No prize claims recorded"
        }
        description={
          summary.state === "active"
            ? "Standings populate as players wager during this race."
            : "Prize claims for this period have not been filed yet."
        }
        compact
      />
    );
  }
  const projectedNote = summary.state === "active";
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px] uppercase tracking-wider text-muted-foreground">
        <span>Top winners</span>
        {projectedNote && <span>Projected</span>}
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[50px]">Rank</TableHead>
            <TableHead>User</TableHead>
            <TableHead className="text-right">Wagered</TableHead>
            <TableHead className="text-right">Prize</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {summary.topWinners.map((w) => (
            <TableRow key={`${w.position}-${w.userId}`}>
              <TableCell className="tabular-nums text-muted-foreground">
                #{w.position}
              </TableCell>
              <TableCell className="font-medium">
                <Link
                  href={`/users/${w.userId}`}
                  className="hover:underline"
                >
                  {w.username ?? w.userId.slice(0, 8)}
                </Link>
              </TableCell>
              <TableCell className="text-right tabular-nums text-muted-foreground">
                {formatCurrency(w.wageredUsd)}
              </TableCell>
              <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(w.prizeAmountUsd)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Breakdown panel — one row per reward type with amount + share bar.
 * Every amount is rose (house cost). Sorted by total descending
 * (already done in the query). Bars use rose to stay in House-POV.
 *
 * Each row carries the drilldown trigger so admins can open the
 * per-ledger-type + top-recipients popover directly from the
 * breakdown panel without scrolling back up to the KPI strip.
 */
function RewardBreakdownPanel({
  categories,
  totalCost,
  breakdownByCategory,
  periodParam,
  periodLabel,
}: {
  categories: {
    key: RewardCategoryKey;
    label: string;
    total: number;
    count: number;
    share: number;
  }[];
  totalCost: number;
  breakdownByCategory: Record<RewardCategoryKey, RewardCategoryBreakdown>;
  periodParam: RewardsPeriod;
  periodLabel: string;
}) {
  const hasData = totalCost > 0;
  if (!hasData) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        <EmptyState
          icon={PieChart}
          title="No reward payouts in this window"
          description="No rewards were paid out in the selected period. Try a longer period."
          compact
        />
      </div>
    );
  }
  return (
    <div className="space-y-2 rounded-2xl border bg-card p-4 sm:p-5">
      {categories.map((c) => {
        const Icon = CATEGORY_ICONS[c.key] ?? Gift;
        const cb = breakdownByCategory[c.key];
        return (
          <div key={c.key} className="rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Icon className="size-4 shrink-0 text-rose-500" />
                <span className="truncate text-sm font-medium">{c.label}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {formatNumber(c.count)}
                </span>
                {cb.total > 0 && (
                  <RewardTileDrilldown
                    category={c.key}
                    label={c.label}
                    breakdownRows={cb.rows}
                    total={cb.total}
                    count={cb.count}
                    periodParam={periodParam}
                    periodLabel={periodLabel}
                  />
                )}
              </div>
              <span className="shrink-0 text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(c.total)}
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2">
              <div className="h-2 flex-1 overflow-hidden rounded-sm bg-muted">
                <div
                  className="h-full rounded-sm bg-rose-500/60 transition-all"
                  style={{ width: `${c.share}%` }}
                />
              </div>
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                {c.share.toFixed(1)}%
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Top recipients — users who received the most reward cost in the
 * period (staff + blacklist already excluded in the query). House-POV:
 * the amount is money we gave them, so it renders rose. Mobile card
 * fallback + desktop table + EmptyState, mirroring the analytics
 * leaderboard tables.
 */
function RecipientsTable({ rows }: { rows: RewardRecipientRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title="No reward recipients in this window"
        description="No users received rewards in the selected period. Try a longer period."
        compact
      />
    );
  }
  return (
    <>
      {/* Mobile card list (<md) */}
      <div className="space-y-1.5 md:hidden">
        {rows.map((r, i) => (
          <div
            key={r.userId}
            className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 transition-colors hover:bg-muted/40"
          >
            <span className="w-7 shrink-0 text-xs tabular-nums text-muted-foreground">
              #{i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <Link
                href={`/users/${r.userId}`}
                className="block truncate text-sm font-medium hover:underline"
              >
                {r.username ?? r.userId.slice(0, 8)}
              </Link>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {formatNumber(r.count)} payouts
              </span>
            </div>
            <span className="shrink-0 text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(r.total)}
            </span>
          </div>
        ))}
      </div>

      {/* Desktop table (>=md) */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[50px]">Rank</TableHead>
              <TableHead>User</TableHead>
              <TableHead className="text-right">Payouts</TableHead>
              <TableHead className="text-right">Reward cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={r.userId}>
                <TableCell className="tabular-nums text-muted-foreground">
                  #{i + 1}
                </TableCell>
                <TableCell className="font-medium">
                  <Link href={`/users/${r.userId}`} className="hover:underline">
                    {r.username ?? r.userId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatNumber(r.count)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(r.total)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
