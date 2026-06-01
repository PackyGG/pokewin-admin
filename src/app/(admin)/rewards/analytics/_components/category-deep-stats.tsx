import Link from "next/link";
import {
  Hash,
  Sigma,
  TrendingDown,
  Users,
  ArrowUpRight,
  CalendarDays,
  Trophy,
  LineChart as LineChartIcon,
} from "lucide-react";
import { SectionHeading, KpiTile } from "@/components/modern-panels";
import { EmptyState } from "@/components/empty-state";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { formatCurrency, formatDate, formatNumber } from "@/lib/utils/format";
import type { CategoryAnalytics } from "@/lib/queries/rewards-category-analytics";
import { DepositBonusChart } from "../deposit-bonus-chart";

/**
 * Shared layout for a per-category deep-stats tab on
 * /rewards/analytics. Each tab (Deposit Bonus / Rakeback / Race /
 * Affiliate / Sign Up) shows:
 *
 *   - KPI strip with the baseline stats (total / count / avg / median
 *     / max / unique recipients) plus any category-specific extras
 *     the caller appends.
 *   - Daily volume time-series chart (rose, matches the rest of the
 *     page).
 *   - Top 10 users by volume + top 10 days by volume side-by-side.
 *
 * House-POV: every category here is money the house GIVES users →
 * rose accent everywhere.
 *
 * The chart is shared with the Deposit Bonus tab (same area-chart
 * shape, same rose family) — reusing the existing component avoids
 * forking a second chart per tab.
 */

/**
 * Tile descriptor for the KPI strip. Each tab passes its core stats
 * + any extras through this list so the strip layout is consistent
 * but the contents stay category-specific.
 */
export type DeepStatsTile = {
  label: string;
  value: string;
  sub?: string;
  /** Icon imported from `lucide-react` by the caller. */
  icon: React.ElementType;
};

/**
 * Render the standard baseline tiles for a CategoryAnalytics payload.
 * Each tab can spread extras around / between these as needed. Used
 * by every tab so the baseline layout stays consistent.
 */
export function baseDeepStatsTiles(
  data: CategoryAnalytics,
  periodLabel: string,
  copy: {
    /** Singular noun for the count tile sub-label, e.g. "Bonuses awarded". */
    countSub: string;
    /** Singular noun for the unique-recipients tile sub-label, e.g. "avg per user". */
    avgPerUserSub?: string;
  },
): DeepStatsTile[] {
  return [
    {
      label: "Total volume",
      value: formatCurrency(data.totalVolume),
      sub: periodLabel,
      icon: TrendingDown,
    },
    {
      label: "Count",
      value: formatNumber(data.count),
      sub: copy.countSub,
      icon: Hash,
    },
    {
      label: "Average",
      value: formatCurrency(data.avg),
      sub: "Per claim",
      icon: Sigma,
    },
    {
      label: "Median",
      value: formatCurrency(data.median),
      sub: "Per claim",
      icon: Sigma,
    },
    {
      label: "Max",
      value: formatCurrency(data.max),
      sub: "Largest single payout",
      icon: ArrowUpRight,
    },
    {
      label: "Unique recipients",
      value: formatNumber(data.uniqueRecipients),
      sub:
        data.uniqueRecipients > 0
          ? `${formatCurrency(data.totalVolume / data.uniqueRecipients)} ${copy.avgPerUserSub ?? "avg per user"}`
          : "—",
      icon: Users,
    },
  ];
}

/**
 * Top-N table of users by volume in the period. Same mobile-card +
 * desktop-table pattern as `DepositBonusTopUsersTable` so every tab
 * reads identically. Volume column is rose (house cost).
 *
 * `unitLabel` lets the caller distinguish bonuses / claims / prizes
 * in the row sub-label without forking a second table component.
 */
function TopUsersTable({
  rows,
  unitLabel,
  emptyTitle,
  emptyDescription,
}: {
  rows: Array<{
    userId: string;
    username: string | null;
    volume: number;
    count: number;
  }>;
  unitLabel: string;
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={Users}
        title={emptyTitle}
        description={emptyDescription}
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
                {formatNumber(r.count)} {unitLabel}
              </span>
            </div>
            <span className="shrink-0 text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(r.volume)}
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
              <TableHead className="text-right">{unitLabel}</TableHead>
              <TableHead className="text-right">Volume</TableHead>
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
                  {formatCurrency(r.volume)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

/**
 * Top-N table of days by volume in the period. Mirrors `TopUsersTable`
 * so the two sit side-by-side on wide screens without one looking
 * heavier. Date renders via `formatDate` for the same date style the
 * rest of the page uses.
 */
function TopDaysTable({
  rows,
  unitLabel,
  emptyTitle,
  emptyDescription,
}: {
  rows: Array<{ date: string; volume: number; count: number }>;
  unitLabel: string;
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={CalendarDays}
        title={emptyTitle}
        description={emptyDescription}
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
            key={r.date}
            className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 transition-colors hover:bg-muted/40"
          >
            <span className="w-7 shrink-0 text-xs tabular-nums text-muted-foreground">
              #{i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {formatDate(r.date)}
              </span>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {formatNumber(r.count)} {unitLabel}
              </span>
            </div>
            <span className="shrink-0 text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(r.volume)}
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
              <TableHead>Date</TableHead>
              <TableHead className="text-right">{unitLabel}</TableHead>
              <TableHead className="text-right">Volume</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={r.date}>
                <TableCell className="tabular-nums text-muted-foreground">
                  #{i + 1}
                </TableCell>
                <TableCell className="font-medium">
                  {formatDate(r.date)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-muted-foreground">
                  {formatNumber(r.count)}
                </TableCell>
                <TableCell className="text-right tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(r.volume)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}

/**
 * Composite per-category deep-stats panel. Renders:
 *   - KPI strip from the tiles list (caller-supplied so each tab can
 *     blend baseline + category-specific stats in any order).
 *   - Daily volume area chart.
 *   - Top users + top days side-by-side.
 *
 * `Icon` heads the section + drives the chart-card glow color
 * indirectly (the chart is rose either way, but the section heading
 * uses the icon visually). `headerTitle` is the section label
 * ("Deposit Bonus", "Rakeback", etc.).
 *
 * Caller passes `unitLabel` so the top-N table column headers /
 * counts read naturally per category ("bonuses" vs "claims" vs
 * "prizes" etc.).
 */
export function CategoryDeepStatsPanel({
  data,
  periodLabel,
  headerIcon: HeaderIcon,
  headerTitle,
  tiles,
  unitLabel,
  emptyTitle,
  emptyDescription,
}: {
  data: CategoryAnalytics;
  periodLabel: string;
  headerIcon: React.ElementType;
  headerTitle: string;
  tiles: DeepStatsTile[];
  unitLabel: string;
  emptyTitle: string;
  emptyDescription: string;
}) {
  if (data.count === 0) {
    return (
      <div className="space-y-3">
        <SectionHeading icon={HeaderIcon} title={headerTitle} />
        <div className="rounded-2xl border bg-card p-4">
          <EmptyState
            icon={HeaderIcon}
            title={emptyTitle}
            description={emptyDescription}
            compact
          />
        </div>
      </div>
    );
  }
  // Adapt grid columns to the tile count so 5–7 tiles all sit on one
  // row on lg+ without forcing a fixed 7-col grid (which would leave
  // gaps for tabs with fewer extras).
  const lgColsClass =
    tiles.length >= 7
      ? "lg:grid-cols-7"
      : tiles.length === 6
        ? "lg:grid-cols-6"
        : "lg:grid-cols-5";
  return (
    <div className="space-y-3">
      <SectionHeading icon={HeaderIcon} title={headerTitle} />
      <div
        className={`grid grid-cols-2 gap-3 sm:grid-cols-3 ${lgColsClass}`}
      >
        {tiles.map((tile) => (
          <KpiTile
            key={tile.label}
            label={tile.label}
            value={tile.value}
            sub={tile.sub}
            icon={tile.icon}
            accent="rose"
          />
        ))}
      </div>

      {/* Daily volume chart — shares the DepositBonusChart component
          since the area-chart shape is identical across categories
          and the colour family (rose) is consistent. */}
      <div className="surface-sheen surface-raise relative overflow-hidden rounded-2xl border bg-gradient-to-br from-card via-card to-card/70 p-4 sm:p-5">
        <div
          aria-hidden
          className="pointer-events-none absolute -right-12 -top-12 size-32 rounded-full bg-rose-500/[0.08] blur-2xl"
        />
        <div className="relative">
          <SectionHeading
            icon={LineChartIcon}
            title={`Daily volume — ${periodLabel}`}
          />
          <div className="mt-3">
            <DepositBonusChart daily={data.dailyVolume} />
          </div>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <div>
          <SectionHeading icon={Trophy} title="Top 10 users by volume" />
          <div className="surface-sheen mt-3 relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <TopUsersTable
              rows={data.topUsers}
              unitLabel={unitLabel}
              emptyTitle="No recipients in this window"
              emptyDescription="No users received a payout in the selected period."
            />
          </div>
        </div>
        <div>
          <SectionHeading icon={CalendarDays} title="Top 10 days by volume" />
          <div className="surface-sheen mt-3 relative overflow-hidden rounded-2xl border bg-card p-4 sm:p-5">
            <TopDaysTable
              rows={data.topDays}
              unitLabel={unitLabel}
              emptyTitle="No days with payouts"
              emptyDescription="No payouts in the selected period."
            />
          </div>
        </div>
      </div>
    </div>
  );
}
