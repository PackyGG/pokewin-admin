"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis, Cell } from "recharts";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Wallet,
  Box,
  Ticket,
  Coins,
  type LucideIcon,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";
import { CHART_COLORS } from "@/lib/constants";
import { cn } from "@/lib/utils";

const wagerConfig = {
  packs: {
    label: "Packs",
    color: "var(--color-chart-2)",
  },
  // `--chart-4` is pure red in both Grailed themes (globals.css), which made
  // battle wager — house income, same quantity as the pack leg beside it —
  // read as a loss. `--chart-3` stays distinct from packs (chart-2) and
  // upgrader (chart-5) in every theme without the loss connotation.
  battles: {
    label: "Battles",
    color: "var(--color-chart-3)",
  },
  keno: {
    label: "Keno",
    color: "var(--color-chart-4)",
  },
  upgrader: {
    label: "Upgrader",
    color: "var(--color-chart-5)",
  },
  doubleDown: {
    label: "Double Down",
    color: "var(--color-chart-1)",
  },
} satisfies ChartConfig;

// Wager Attribution split — organic vs creator-coded. Cyan for organic
// (matches the dashboard's "Organic Wager" KPI tile) and amber for
// creator-coded so the two bands read clearly and don't collide with
// the Wagers chart's packs/battles/upgrader hues sitting beside it.
const wagerAttributionConfig = {
  organic: {
    label: "Organic",
    color: CHART_COLORS.cyan,
  },
  creatorCoded: {
    label: "Creator-coded",
    color: CHART_COLORS.amber,
  },
} satisfies ChartConfig;

const depositsConfig = {
  amount: {
    label: "Deposits",
    color: "var(--color-chart-3)",
  },
} satisfies ChartConfig;

// Merged Signups+FTDs chart. House-POV: a SIGNUP moves no money — the
// canonical `ledgerDirection` map classifies `signup` as neutral — so it is
// blue, not emerald. An FTD is a real deposit (house gained) and keeps
// emerald. Grouped (not stacked) because FTDs are a STRICT subset of signups:
// every FTD is also a signup on the same day or later, and stacking would
// visually double-count. Grouped pairs make the conversion gap obvious.
const signupsConfig = {
  signups: {
    label: "Signups",
    color: CHART_COLORS.blue,
  },
  ftds: {
    label: "FTDs",
    color: CHART_COLORS.emerald,
  },
} satisfies ChartConfig;

// Active Depositors — a count, not money, so it takes a neutral series hue
// that stays distinct from the Signups & FTDs chart beside it.
const activeDepositorsConfig = {
  count: {
    label: "Depositors",
    color: CHART_COLORS.cyan,
  },
} satisfies ChartConfig;

// Cash P&L bars are colored per-day by sign (House-POV): house up =
// emerald, house down = rose.
const PNL_UP = CHART_COLORS.emerald;
const PNL_DOWN = CHART_COLORS.rose;

/**
 * Custom tooltip for the stacked Wagers chart — renders Packs + Battles
 * + Upgrader with their colors, the share of the day each contributed
 * (% of total), then a "Total" row showing all five combined. The
 * default ChartTooltipContent only lists individual stack segments
 * without proportions, so an admin had to mentally add the segments
 * AND compute the ratio.
 *
 * Styling mirrors ChartTooltipContent (see src/components/ui/chart.tsx)
 * so the two tooltips stay visually consistent across the dashboard.
 */
function WagerTooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{
    dataKey?: string | number;
    value?: number | string;
    color?: string;
  }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const labelByKey: Record<string, string> = {
    packs: "Packs",
    battles: "Battles",
    keno: "Keno",
    upgrader: "Upgrader",
    doubleDown: "Double Down",
  };
  const total = payload.reduce(
    (sum, item) => sum + Number(item?.value ?? 0),
    0,
  );
  return (
    <div className="grid min-w-40 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      {label && <div className="font-medium">{label}</div>}
      <div className="grid gap-1.5">
        {payload.map((item) => {
          const key = String(item.dataKey ?? "");
          const value = Number(item.value ?? 0);
          // Share of the day's total. Falls back to 0% on zero-volume
          // days so the row reads "0.0%" instead of NaN%.
          const pct = total > 0 ? (value / total) * 100 : 0;
          return (
            <div key={key} className="flex items-center gap-2">
              <div
                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ background: item.color }}
              />
              <div className="flex flex-1 items-center justify-between leading-none">
                <span className="text-muted-foreground">
                  {labelByKey[key] ?? key}
                </span>
                <span className="font-mono font-medium tabular-nums text-foreground">
                  {formatCurrency(value)}
                  <span className="ml-1 text-muted-foreground">
                    ({pct.toFixed(1)}%)
                  </span>
                </span>
              </div>
            </div>
          );
        })}
        <div className="mt-0.5 flex items-center gap-2 border-t border-border/50 pt-1.5">
          {/* Spacer to align the Total label with the rows above. */}
          <div className="h-2.5 w-2.5 shrink-0" />
          <div className="flex flex-1 items-center justify-between leading-none">
            <span className="font-semibold">Total</span>
            <span className="font-mono font-semibold tabular-nums text-foreground">
              {formatCurrency(total)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatChartXTick(value: string, hourlyXAxis: boolean): string {
  return hourlyXAxis ? value : value.slice(5);
}

// Compact integer formatter for count-based YAxis ticks (Signups, FTDs,
// Depositors). Mirrors formatCompactUsd's K/M tier but without the $ sign so
// the Wagers/Deposits ($-axis) and the count charts stay visually consistent
// in the same row while reading the right unit per axis.
function formatCompactInt(v: number): string {
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

export function WagerChart({
  data,
  title = "Wagers (30 days)",
  hourlyXAxis = false,
}: {
  data: {
    date: string;
    packs: number;
    battles: number;
    keno?: number;
    upgrader: number;
    doubleDown?: number;
  }[];
  title?: string;
  /** When true, show x-axis labels verbatim (hourly buckets). Default strips
   *  the year prefix (`MM-DD`) for daily buckets. */
  hourlyXAxis?: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={wagerConfig} className="aspect-auto h-[220px] w-full md:h-[260px] lg:h-[300px]">
          <BarChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => formatChartXTick(v, hourlyXAxis)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={70}
              tickFormatter={formatCompactUsd}
            />
            <ChartTooltip content={<WagerTooltipContent />} />
            {/* Stacked bars: Packs at the bottom, Battles in the
                middle, Upgrader on top. Only the top segment gets the
                rounded corner so the stack reads as one bar. */}
            <Bar
              dataKey="packs"
              stackId="wager"
              fill="var(--color-packs)"
              radius={[0, 0, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="battles"
              stackId="wager"
              fill="var(--color-battles)"
              radius={[0, 0, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="keno"
              stackId="wager"
              fill="var(--color-keno)"
              radius={[0, 0, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="upgrader"
              stackId="wager"
              fill="var(--color-upgrader)"
              radius={[0, 0, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="doubleDown"
              stackId="wager"
              fill="var(--color-doubleDown)"
              radius={[4, 4, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

export function DepositsChart({
  data,
  title = "Deposits (30 days)",
  hourlyXAxis = false,
}: {
  data: { date: string; amount: number }[];
  title?: string;
  /** When true, show x-axis labels verbatim (hourly buckets). Default strips
   *  the year prefix (`MM-DD`) for daily buckets. */
  hourlyXAxis?: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={depositsConfig} className="aspect-auto h-[220px] w-full md:h-[260px] lg:h-[300px]">
          <BarChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => formatChartXTick(v, hourlyXAxis)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={70}
              tickFormatter={formatCompactUsd}
            />
            <ChartTooltip content={<DepositsTooltipContent />} />
            <Bar
              dataKey="amount"
              fill="var(--color-amount)"
              radius={[4, 4, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/**
 * Tooltip for the Deposits chart — same visual weight as the Wagers
 * tooltip (bold value, semibold figure, color chip), instead of the
 * default ChartTooltipContent which rendered the formatter string
 * unstyled and read as light grey text.
 */
function DepositsTooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{
    dataKey?: string | number;
    value?: number | string;
    color?: string;
  }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const item = payload[0];
  const amount = Number(item?.value ?? 0);
  return (
    <div className="grid min-w-32 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      {label && <div className="font-medium">{label}</div>}
      <div className="flex items-center gap-2">
        <div
          className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
          style={{ background: item?.color }}
        />
        <div className="flex flex-1 items-center justify-between leading-none">
          <span className="text-muted-foreground">Deposits</span>
          <span className="font-mono font-semibold tabular-nums text-foreground">
            {formatCurrency(amount)}
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Tooltip for the merged Signups + FTDs chart — labels both series with
 * their daily counts plus the day's FTD total/average (carried on the FTD
 * row so the hover still surfaces the same numbers the standalone FTD card
 * used to show). Conversion percentage (FTD/signup) is appended when both
 * are non-zero so the day's signup-to-deposit funnel reads at a glance.
 *
 * Styling mirrors ChartTooltipContent's container so it lines up with the
 * other dashboard tooltips.
 */
function SignupsFtdsTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{
    dataKey?: string | number;
    value?: number | string;
    color?: string;
    payload?: { signups?: number; ftds?: number; ftdTotal?: number; ftdAvg?: number };
  }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0]?.payload ?? {};
  const signups = Number(row.signups ?? 0);
  const ftds = Number(row.ftds ?? 0);
  const ftdTotal = Number(row.ftdTotal ?? 0);
  const ftdAvg = Number(row.ftdAvg ?? 0);
  const conversion = signups > 0 ? (ftds / signups) * 100 : 0;
  const labelByKey: Record<string, string> = {
    signups: "Signups",
    ftds: "FTDs",
  };
  return (
    <div className="grid min-w-44 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      {label && <div className="font-medium">{label}</div>}
      <div className="grid gap-1.5">
        {payload.map((item) => {
          const key = String(item.dataKey ?? "");
          const value = Number(item.value ?? 0);
          return (
            <div key={key} className="flex items-center gap-2">
              <div
                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ background: item.color }}
              />
              <div className="flex flex-1 items-center justify-between leading-none">
                <span className="text-muted-foreground">
                  {labelByKey[key] ?? key}
                </span>
                <span className="font-mono font-medium tabular-nums text-foreground">
                  {value}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {ftds > 0 && (
        <div className="mt-0.5 grid gap-0.5 border-t border-border/50 pt-1.5 text-[11px] text-muted-foreground">
          <div className="flex items-center justify-between">
            <span>FTD total</span>
            <span className="font-mono tabular-nums text-foreground">
              {formatCurrency(ftdTotal)}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span>FTD avg</span>
            <span className="font-mono tabular-nums text-foreground">
              {formatCurrency(ftdAvg)}
            </span>
          </div>
          {signups > 0 && (
            <div className="flex items-center justify-between">
              <span>Conversion</span>
              <span className="font-mono tabular-nums text-foreground">
                {conversion.toFixed(1)}%
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Merged Signups + FTDs daily chart — grouped (side-by-side) bars in two
 * emerald shades. Replaces the prior single-series Signups chart AND the
 * standalone FTDs card so the funnel reads in one place: a tall emerald-500
 * signup bar next to a short emerald-300 FTD bar shows the conversion gap
 * per day. Both series are House-POV neutral growth (no red/green semantics).
 *
 * Joined by date upstream in `page.tsx` (`mergeSignupsAndFtds`) so missing
 * days are zero-filled on both sides — the padded series are already
 * date-aligned by the dashboard query layer.
 *
 * Visual structure mirrors WagerChart (same Card chrome, same
 * `aspect-auto h-[220px]...` ChartContainer, same axis treatment with a
 * fixed-width YAxis carrying a compact tick formatter) so this card reads
 * as a sibling of the Wagers chart sitting beside it in row 1, not a
 * different system. The unit on the YAxis is a count (not USD), so it
 * uses `formatCompactInt` instead of `formatCompactUsd`.
 */
export function SignupsChart({
  data,
  title = "Signups & FTDs (30 days)",
  hourlyXAxis = false,
}: {
  data: {
    date: string;
    signups: number;
    ftds: number;
    ftdTotal: number;
    ftdAvg: number;
  }[];
  title?: string;
  hourlyXAxis?: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={signupsConfig}
          className="aspect-auto h-[220px] w-full md:h-[260px] lg:h-[300px]"
        >
          <BarChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => formatChartXTick(v, hourlyXAxis)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={70}
              tickFormatter={formatCompactInt}
            />
            <ChartTooltip content={<SignupsFtdsTooltip />} />
            {/* Grouped (side-by-side) bars: Signups in emerald-500,
                FTDs in emerald-300. Both get the same rounded-top
                radius so each pair reads as a matched siblings
                (Wagers uses radius on the top stack segment only;
                here both bars are tops because they aren't stacked). */}
            <Bar
              dataKey="signups"
              fill="var(--color-signups)"
              radius={[4, 4, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="ftds"
              fill="var(--color-ftds)"
              radius={[4, 4, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

export function ActiveDepositorsChart({
  data,
  title = "Active Depositors (30 days)",
  hourlyXAxis = false,
}: {
  data: { date: string; count: number }[];
  title?: string;
  hourlyXAxis?: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={activeDepositorsConfig} className="h-[220px] w-full md:h-[260px] lg:h-[300px]">
          <BarChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => formatChartXTick(v, hourlyXAxis)}
            />
            <YAxis tickLine={false} axisLine={false} tickMargin={8} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar
              dataKey="count"
              fill="var(--color-count)"
              radius={[4, 4, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/** One breakdown row inside the daily-P&L tooltip — an icon chip, the
 *  component label, and its SIGNED contribution to house P&L colored
 *  House-POV (a positive contribution / shrinking liability reads emerald,
 *  a negative one rose). Mirrors the "P&L Today" tile's popover rows
 *  (today-pnl-stat-card.tsx) so the two surfaces read identically. */
function PnlBreakdownTooltipRow({
  label,
  contribution,
  icon: Icon,
}: {
  label: string;
  contribution: number;
  icon: LucideIcon;
}) {
  const positive = contribution >= 0;
  const amountColor = positive
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-rose-600 dark:text-rose-400";
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="size-3 shrink-0" />
        {label}
      </span>
      <span className={cn("font-mono font-medium tabular-nums", amountColor)}>
        {positive ? "+" : "−"}
        {formatCurrency(Math.abs(contribution))}
      </span>
    </div>
  );
}

/**
 * Tooltip for the Wager Attribution chart — same shape as the Wagers
 * tooltip (per-segment row + Total row below the divider). Each row
 * shows the segment's dollar value AND its share of the day's total
 * (`Organic 65%`, `Creator-coded 35%`), since the point of the chart
 * is the split between the two bands — not the absolute dollars,
 * which the Wagers chart already covers. The Total row carries the
 * day's combined customer wager. Percentages fall back to 0 % on
 * zero-volume days so the row reads "0%" instead of NaN%.
 */
function WagerAttributionTooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{
    dataKey?: string | number;
    value?: number | string;
    color?: string;
  }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const labelByKey: Record<string, string> = {
    organic: "Organic",
    creatorCoded: "Creator-coded",
  };
  const total = payload.reduce(
    (sum, item) => sum + Number(item?.value ?? 0),
    0,
  );
  return (
    <div className="grid min-w-40 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      {label && <div className="font-medium">{label}</div>}
      <div className="grid gap-1.5">
        {payload.map((item) => {
          const key = String(item.dataKey ?? "");
          const value = Number(item.value ?? 0);
          const pct = total > 0 ? (value / total) * 100 : 0;
          return (
            <div key={key} className="flex items-center gap-2">
              <div
                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ background: item.color }}
              />
              <div className="flex flex-1 items-center justify-between leading-none">
                <span className="text-muted-foreground">
                  {labelByKey[key] ?? key}
                </span>
                <span className="font-mono font-medium tabular-nums text-foreground">
                  {formatCurrency(value)}
                  <span className="ml-1 text-muted-foreground">
                    ({pct.toFixed(1)}%)
                  </span>
                </span>
              </div>
            </div>
          );
        })}
        <div className="mt-0.5 flex items-center gap-2 border-t border-border/50 pt-1.5">
          <div className="h-2.5 w-2.5 shrink-0" />
          <div className="flex flex-1 items-center justify-between leading-none">
            <span className="font-semibold">Total</span>
            <span className="font-mono font-semibold tabular-nums text-foreground">
              {formatCurrency(total)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Wager Attribution (30 days) — stacked daily wager split into
 *   • Organic       → customers without a creator-code referral
 *   • Creator-coded → customers whose referrer is a creator role user
 *
 * Both segments exclude staff (admin/support) AND the creator role
 * itself on both sides, so the bars represent pure customer wager —
 * the same scope the Organic Wager KPI tile uses. Stacking the two
 * gives total customer wager per day; the divergence between the
 * bands is the chart's point.
 */
export function WagerAttributionChart({
  data,
  title = "Wager Attribution (30 days)",
  hourlyXAxis = false,
}: {
  data: { date: string; organic: number; creatorCoded: number }[];
  title?: string;
  hourlyXAxis?: boolean;
}) {
  // 30-day rollup for the card header. The bars expose per-day
  // numbers; the title strip carries the period sum + the organic /
  // creator-coded share so admins read the headline split without
  // having to mentally sum the bars.
  const organicTotal = data.reduce((sum, d) => sum + d.organic, 0);
  const creatorCodedTotal = data.reduce((sum, d) => sum + d.creatorCoded, 0);
  const periodTotal = organicTotal + creatorCodedTotal;
  const organicPct = periodTotal > 0 ? (organicTotal / periodTotal) * 100 : 0;
  const creatorCodedPct = periodTotal > 0 ? (creatorCodedTotal / periodTotal) * 100 : 0;
  return (
    // `h-full` stretches the card to fill the grid row in the 50/50
    // pair with Upgrader Stats so the two cards always align at the
    // bottom, regardless of which side resolved first.
    <Card className="h-full">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
            {formatCurrency(periodTotal)}
          </span>
        </div>
        {/* Mini legend — each colour chip carries its 30-day dollar
            total + share of the period. Reads bottom-to-top with the
            stack: organic first (the bigger band on most days),
            creator-coded second. */}
        <CardDescription className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 shrink-0 rounded-[2px]"
              style={{ background: "var(--color-organic)" }}
            />
            <span className="text-muted-foreground">Organic</span>
            <span className="font-mono font-medium tabular-nums text-foreground">
              {formatCurrency(organicTotal)}
            </span>
            <span className="text-muted-foreground">
              ({organicPct.toFixed(1)}%)
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 shrink-0 rounded-[2px]"
              style={{ background: "var(--color-creatorCoded)" }}
            />
            <span className="text-muted-foreground">Creator-coded</span>
            <span className="font-mono font-medium tabular-nums text-foreground">
              {formatCurrency(creatorCodedTotal)}
            </span>
            <span className="text-muted-foreground">
              ({creatorCodedPct.toFixed(1)}%)
            </span>
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={wagerAttributionConfig}
          className="h-[220px] w-full md:h-[260px] lg:h-[300px]"
        >
          <BarChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => formatChartXTick(v, hourlyXAxis)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={70}
              tickFormatter={formatCompactUsd}
            />
            <ChartTooltip content={<WagerAttributionTooltipContent />} />
            {/* Organic at the bottom, Creator-coded on top — same
                visual logic the Wagers chart uses (only the top
                segment gets the rounded corner so the stack reads as
                one bar). */}
            <Bar
              dataKey="organic"
              stackId="wagerAttribution"
              fill="var(--color-organic)"
              radius={[0, 0, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="creatorCoded"
              stackId="wagerAttribution"
              fill="var(--color-creatorCoded)"
              radius={[4, 4, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

// Same ChartContainer config shape the removed Daily-P&L chart used — cells
// override the per-bar fill by sign, but ChartContainer still requires a
// config entry for the `cashPnl` dataKey so the legend / tooltip context
// wire up cleanly.
const cashPnlConfig = {
  cashPnl: { label: "Cash P&L" },
} satisfies ChartConfig;

/**
 * Hover for the Daily Cash P&L chart — leads with the chart's own metric
 * (deposits − withdrawals, the bars' basis), then appends the FULL canonical
 * house-P&L breakdown that used to live in the standalone "Daily P&L" chart's
 * tooltip (Deposits/Withdrawals/Balance/Inventory/Voucher contributions +
 * the reconciling P&L line + informational creator cost). That chart was
 * removed and its data merged into this hover — the bars themselves stay
 * deposits − withdrawals only; the extra rows are additional context.
 * House-POV coloring throughout: cash flowed INTO the house / a shrinking
 * liability → emerald, the opposite → rose.
 */
function CashPnlTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{
    payload: {
      date: string;
      deposits: number;
      withdrawals: number;
      cashPnl: number;
      pnl: number;
      balanceChange: number;
      inventoryChange: number;
      voucherChange: number;
      creatorCost?: number;
    };
  }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const up = p.cashPnl > 0;
  const down = p.cashPnl < 0;
  const pnlUp = p.pnl >= 0;
  const creatorCost = p.creatorCost ?? 0;
  // Signed contribution to the canonical house P&L (deposits add; every
  // other term subtracts) — same rows the removed Daily P&L chart showed.
  const rows: Array<{ label: string; contribution: number; icon: LucideIcon }> =
    [
      { label: "Deposits", contribution: p.deposits, icon: ArrowDownToLine },
      {
        label: "Withdrawals",
        contribution: -p.withdrawals,
        icon: ArrowUpFromLine,
      },
      {
        label: "User Balance change",
        contribution: -p.balanceChange,
        icon: Wallet,
      },
      { label: "Inventory change", contribution: -p.inventoryChange, icon: Box },
      { label: "Voucher change", contribution: -p.voucherChange, icon: Ticket },
    ];
  return (
    <div className="grid min-w-52 gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-2 text-xs shadow-xl">
      <span className="font-medium text-foreground">{p.date}</span>
      {/* Primary line — the chart's own metric (deposits − withdrawals). */}
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-1.5 font-semibold text-foreground">
          <Coins className="size-3 shrink-0" />
          Cash P&amp;L
        </span>
        <span
          className={cn(
            "font-mono font-bold tabular-nums",
            up && "text-emerald-600 dark:text-emerald-400",
            down && "text-rose-600 dark:text-rose-400",
            !up && !down && "text-muted-foreground",
          )}
        >
          {up ? "+" : down ? "−" : ""}
          {formatCurrency(Math.abs(p.cashPnl))}
        </span>
      </div>
      {/* Merged from the removed Daily P&L chart — the full canonical
          breakdown, as additional hover context. */}
      <div className="mt-0.5 grid gap-1 border-t border-border/50 pt-1.5">
        {rows.map((r) => (
          <PnlBreakdownTooltipRow
            key={r.label}
            label={r.label}
            contribution={r.contribution}
            icon={r.icon}
          />
        ))}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-1.5">
        <span className="font-semibold text-foreground">P&amp;L</span>
        <span
          className={cn(
            "font-mono font-bold tabular-nums",
            pnlUp
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400",
          )}
        >
          {pnlUp ? "+" : "−"}
          {formatCurrency(Math.abs(p.pnl))}
        </span>
      </div>
      {creatorCost > 0 && (
        <div className="flex items-center justify-between gap-3 border-t border-dashed border-border/40 pt-1.5 text-[11px]">
          <span className="text-muted-foreground">Creator cost (in P&amp;L)</span>
          <span className="font-mono tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(creatorCost)}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Daily Cash P&L (30 days) — visualizes the per-day raw fiat + crypto cash flow
 * (deposits − withdrawals) via the bars, House-POV per-bar colored (emerald
 * when we actually made real crypto money that day, rose when more cash
 * flowed out than in, muted on zero-flow days). The hover ALSO carries the
 * full canonical house-P&L breakdown (merged from the removed standalone
 * "Daily P&L" chart — see `CashPnlTooltip`), so this one chart now surfaces
 * both figures: the bars stay cash-flow-only, the breakdown is hover-only.
 *
 * Reuses the same getDailyPnl data the removed chart consumed — no new
 * query — by deriving `cashPnl = deposits - withdrawals` on the page before
 * handing the rows down.
 */
export function CashPnlChart({
  data,
}: {
  data: {
    date: string;
    deposits: number;
    withdrawals: number;
    cashPnl: number;
    pnl: number;
    balanceChange: number;
    inventoryChange: number;
    voucherChange: number;
    /** Informational per-day creator cost (already inside P&L; hover-only). */
    creatorCost?: number;
  }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Daily Cash P&amp;L (30 days)
        </CardTitle>
        <CardDescription className="text-xs">
          Deposits − withdrawals per day. Green = completed fiat + crypto inflow.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={cashPnlConfig} className="h-[220px] w-full md:h-[260px] lg:h-[300px]">
          <BarChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => v.slice(5)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={70}
              tickFormatter={formatCompactUsd}
            />
            <ChartTooltip content={<CashPnlTooltip />} />
            <Bar
              dataKey="cashPnl"
              radius={[4, 4, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            >
              {data.map((d) => (
                <Cell
                  key={d.date}
                  // Per-bar fill by sign — same House-POV convention the
                  // canonical Daily P&L chart uses (PNL_UP / PNL_DOWN). A
                  // zero-flow day reads muted so it doesn't visually claim
                  // a win/loss it didn't represent.
                  fill={
                    d.cashPnl > 0
                      ? PNL_UP
                      : d.cashPnl < 0
                        ? PNL_DOWN
                        : "var(--color-muted-foreground)"
                  }
                  className="transition-opacity hover:opacity-80"
                />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
