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
} from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import {
  PageHero,
  PageHeroIdentity,
  SectionHeading,
  KpiTile,
  StatPanel,
  PanelRow,
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
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  getRewardsAnalytics,
  type RewardsPeriod,
  type RewardCategoryKey,
  type RewardRecipientRow,
} from "@/lib/queries/rewards-analytics";
import { RewardsPeriodFilter } from "./period-filter";
import { RewardsCostChart } from "./rewards-chart";

export const metadata = { title: "Rewards Analytics" };

function parsePeriod(value: string | undefined): RewardsPeriod {
  switch (value) {
    case "today":
    case "7d":
    case "30d":
    case "all":
      return value;
    default:
      return "30d";
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

// Per-category icon + accent for the breakdown panel. Accent stays in
// the rose family for the cost tiles (House-POV), but the breakdown
// rows use neutral chrome with rose amounts.
const CATEGORY_ICONS: Record<RewardCategoryKey, React.ElementType> = {
  bonuses: Gift,
  rakeback: Percent,
  affiliate: Share2,
  rainRace: CloudRain,
  signupPack: Sparkles,
  creatorTip: Sparkles,
  waitlist: Hash,
  vouchers: Gift,
};

export default async function RewardsAnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  await requirePageAccess("/rewards/analytics");
  const params = await searchParams;
  const period = parsePeriod(params.period);
  const data = await getRewardsAnalytics(period);

  // KPI strip: total cost + the five biggest reward buckets. Categories
  // are pre-sorted by total; we look each one up by key so the strip
  // order is stable (not data-dependent) and always House-POV rose.
  const byKey = new Map(data.categories.map((c) => [c.key, c]));
  const kpiCategories: { key: RewardCategoryKey; label: string; icon: React.ElementType }[] = [
    { key: "bonuses", label: "Bonuses & Promos", icon: Gift },
    { key: "rakeback", label: "Rakeback", icon: Percent },
    { key: "affiliate", label: "Affiliate", icon: Share2 },
    { key: "rainRace", label: "Rain / Race", icon: CloudRain },
    { key: "signupPack", label: "Signup Rewards", icon: Sparkles },
  ];

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

      {/* KPI strip — all rose (house cost), AnimatedNumber + tabular-nums. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile
          label={`Total Rewards (${periodLabel(period)})`}
          value={formatCurrency(data.totalCost)}
          sub={`${formatNumber(data.totalCount)} payouts`}
          icon={TrendingDown}
          accent="rose"
        />
        {kpiCategories.map(({ key, label, icon }) => {
          const cat = byKey.get(key);
          const total = cat?.total ?? 0;
          const share = cat?.share ?? 0;
          return (
            <KpiTile
              key={key}
              label={label}
              value={formatCurrency(total)}
              sub={`${share.toFixed(1)}% of cost`}
              icon={icon}
              accent="rose"
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

      {/* Breakdown by type + summary side by side on wide screens. */}
      <FadeIn>
        <div className="grid gap-4 xl:grid-cols-2">
          <div>
            <SectionHeading icon={PieChart} title="Breakdown by reward type" />
            <div className="mt-3">
              <RewardBreakdownPanel
                categories={data.categories}
                totalCost={data.totalCost}
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
                  {data.categories.map((c) => (
                    <PanelRow
                      key={c.key}
                      label={`${c.label} · ${formatNumber(c.count)}`}
                      value={
                        <span className="text-rose-600 dark:text-rose-400">
                          {formatCurrency(c.total)}
                        </span>
                      }
                    />
                  ))}
                </div>
              </StatPanel>
            </div>
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
 * Breakdown panel — one row per reward type with amount + share bar.
 * Every amount is rose (house cost). Sorted by total descending
 * (already done in the query). Bars use rose to stay in House-POV.
 */
function RewardBreakdownPanel({
  categories,
  totalCost,
}: {
  categories: {
    key: RewardCategoryKey;
    label: string;
    total: number;
    count: number;
    share: number;
  }[];
  totalCost: number;
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
        return (
          <div key={c.key} className="rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <Icon className="size-4 shrink-0 text-rose-500" />
                <span className="truncate text-sm font-medium">{c.label}</span>
                <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                  {formatNumber(c.count)}
                </span>
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
 * the amount is money we gave them, so it renders rose. Mobile-card
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
