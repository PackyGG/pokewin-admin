"use client";

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis, Cell } from "recharts";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Wallet,
  Box,
  Ticket,
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
import { cn } from "@/lib/utils";
import { DailyPnlBreakdownModal } from "./daily-pnl-breakdown-modal";

const wagerConfig = {
  packs: {
    label: "Packs",
    color: "var(--color-chart-2)",
  },
  battles: {
    label: "Battles",
    color: "var(--color-chart-4)",
  },
  upgrader: {
    label: "Upgrader",
    color: "var(--color-chart-5)",
  },
} satisfies ChartConfig;

// Wager Attribution split — organic vs creator-coded. Cyan for organic
// (matches the dashboard's "Organic Wager" KPI tile) and amber for
// creator-coded so the two bands read clearly and don't collide with
// the Wagers chart's packs/battles/upgrader hues sitting beside it.
const wagerAttributionConfig = {
  organic: {
    label: "Organic",
    color: "#06b6d4",
  },
  creatorCoded: {
    label: "Creator-coded",
    color: "#f59e0b",
  },
} satisfies ChartConfig;

const depositsConfig = {
  amount: {
    label: "Deposits",
    color: "var(--color-chart-3)",
  },
} satisfies ChartConfig;

const signupsConfig = {
  count: {
    label: "Signups",
    color: "var(--color-chart-1)",
  },
} satisfies ChartConfig;

const ftdsConfig = {
  count: {
    label: "FTDs",
    color: "var(--color-chart-5)",
  },
} satisfies ChartConfig;

// Active Depositors uses a hex (cyan-500) rather than a chart-N var so
// it stays visually distinct from the Signups chart in the same row.
const activeDepositorsConfig = {
  count: {
    label: "Depositors",
    color: "#06b6d4",
  },
} satisfies ChartConfig;

// P&L bars are colored per-day by sign (House-POV): house up = emerald,
// house down = rose. Cell fills override the config, but ChartContainer
// still needs a config entry for the dataKey.
const pnlConfig = {
  pnl: { label: "P&L" },
} satisfies ChartConfig;

const PNL_UP = "#10b981"; // emerald-500 — house in profit that day
const PNL_DOWN = "#f43f5e"; // rose-500 — house down that day

/**
 * Custom tooltip for the stacked Wagers chart — renders Packs + Battles
 * + Upgrader with their colors, the share of the day each contributed
 * (% of total), then a "Total" row showing all three combined. The
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
    upgrader: "Upgrader",
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

export function WagerChart({
  data,
  title = "Wagers (30 days)",
  hourlyXAxis = false,
}: {
  data: { date: string; packs: number; battles: number; upgrader: number }[];
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
        <ChartContainer config={wagerConfig} className="h-[220px] w-full md:h-[260px] lg:h-[300px]">
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
              dataKey="upgrader"
              stackId="wager"
              fill="var(--color-upgrader)"
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
        <ChartContainer config={depositsConfig} className="h-[220px] w-full md:h-[260px] lg:h-[300px]">
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

export function SignupsChart({
  data,
}: {
  data: { date: string; count: number }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Signups (30 days)</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={signupsConfig} className="h-[220px] w-full md:h-[260px] lg:h-[300px]">
          <BarChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => v.slice(5)}
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

export function ActiveDepositorsChart({
  data,
}: {
  data: { date: string; count: number }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Active Depositors (30 days)
        </CardTitle>
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
              tickFormatter={(v) => v.slice(5)}
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

/**
 * Custom hover for the FTDs chart — the bar shows the daily count, and the
 * tooltip adds the total first-deposit value and the average. Recharts
 * clones this element with `active`/`payload`, so we read the day's row off
 * payload[0].payload. Styling mirrors ChartTooltipContent's container.
 */
function FtdsTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { count: number; total: number; avg: number } }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="grid min-w-32 gap-0.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <span className="font-medium text-foreground">
        {p.count} {p.count === 1 ? "FTD" : "FTDs"}
      </span>
      <span className="text-muted-foreground">
        Total {formatCurrency(p.total)}
      </span>
      <span className="text-muted-foreground">Avg {formatCurrency(p.avg)}</span>
    </div>
  );
}

export function FtdsChart({
  data,
}: {
  data: { date: string; count: number; total: number; avg: number }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">FTDs (30 days)</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={ftdsConfig} className="h-[220px] w-full md:h-[260px] lg:h-[300px]">
          <BarChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => v.slice(5)}
            />
            <YAxis tickLine={false} axisLine={false} tickMargin={8} />
            <ChartTooltip content={<FtdsTooltip />} />
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
 * Hover for the daily P&L chart — full House-POV breakdown of where the
 * day's money went. The day's net deposit inflow (deposits − withdrawals)
 * mostly flows into GROWTH of user balance + inventory + voucher liability
 * (things we owe users), so a big "752 in / 233 out" day can still net only
 * a small realized P&L — these rows show exactly that.
 *
 * Each row carries its SIGNED contribution to house P&L per the canonical
 * formula  pnl = deposits − withdrawals − balanceΔ − inventoryΔ − voucherΔ:
 * deposits add; withdrawals and the three liability deltas subtract (a
 * SHRINKING liability is a negative delta → a positive contribution → reads
 * emerald). The five contributions sum to the P&L on the bottom line, so the
 * tooltip reconciles by construction with the bar height. Same component
 * set + coloring as the "P&L Today" tile.
 */
function PnlTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{
    payload: {
      date: string;
      pnl: number;
      deposits: number;
      withdrawals: number;
      balanceChange: number;
      inventoryChange: number;
      voucherChange: number;
    };
  }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const up = p.pnl >= 0;
  // Signed contribution to house P&L. Deposits add; every other term
  // subtracts (so a positive liability delta — a liability that GREW —
  // becomes a negative contribution, and a shrinking liability a positive
  // one). These five sum to `pnl`.
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
      <div className="grid gap-1">
        {rows.map((r) => (
          <PnlBreakdownTooltipRow
            key={r.label}
            label={r.label}
            contribution={r.contribution}
            icon={r.icon}
          />
        ))}
      </div>
      {/* Bottom line: the five contributions above sum to this P&L —
          House-POV colored (house up → emerald, house down → rose). */}
      <div className="mt-0.5 flex items-center justify-between gap-3 border-t border-border/50 pt-1.5">
        <span className="font-semibold text-foreground">P&amp;L</span>
        <span
          className={cn(
            "font-mono font-bold tabular-nums",
            up
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400",
          )}
        >
          {up ? "+" : "−"}
          {formatCurrency(Math.abs(p.pnl))}
        </span>
      </div>
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
}: {
  data: { date: string; organic: number; creatorCoded: number }[];
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
          <CardTitle className="text-sm font-medium">
            Wager Attribution (30 days)
          </CardTitle>
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
              tickFormatter={(v) => v.slice(5)}
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

export function PnlChart({
  data,
}: {
  data: {
    date: string;
    pnl: number;
    deposits: number;
    withdrawals: number;
    balanceChange: number;
    inventoryChange: number;
    voucherChange: number;
  }[];
}) {
  // The clicked day's YYYY-MM-DD key — drives the drilldown modal. null when
  // closed. The day's full breakdown is fetched lazily INSIDE the modal (a
  // server action on first open), so the dashboard's initial render never
  // loads it — only the click does (CLAUDE.md active-timeframe / lazy rule).
  const [openDay, setOpenDay] = useState<string | null>(null);

  // Recharts hands the Bar's click handler the bar datum; its `payload`
  // carries the row we render (`{ date, pnl, … }`). Pull the day key off it
  // and open the modal. Defensive: only open when a string date is present.
  const handleBarClick = (entry: unknown) => {
    const date =
      entry && typeof entry === "object" && "payload" in entry
        ? (entry as { payload?: { date?: unknown } }).payload?.date
        : (entry as { date?: unknown })?.date;
    if (typeof date === "string" && date.length > 0) setOpenDay(date);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Daily P&amp;L (30 days)
        </CardTitle>
        <CardDescription className="text-xs">
          Click a bar for that day&apos;s full breakdown.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer config={pnlConfig} className="h-[220px] w-full md:h-[260px] lg:h-[300px]">
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
            <ChartTooltip content={<PnlTooltip />} />
            {/* Clickable bars — onClick opens the per-day drilldown modal.
                `cursor-pointer` on each Cell is the affordance; the shared
                ChartTooltip already provides the hover highlight. Reduced-
                motion is unaffected (no extra animation introduced). */}
            <Bar
              dataKey="pnl"
              radius={[4, 4, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
              onClick={handleBarClick}
              className="cursor-pointer"
            >
              {data.map((d) => (
                <Cell
                  key={d.date}
                  fill={d.pnl >= 0 ? PNL_UP : PNL_DOWN}
                  className="cursor-pointer transition-opacity hover:opacity-80"
                />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
      <DailyPnlBreakdownModal day={openDay} onClose={() => setOpenDay(null)} />
    </Card>
  );
}
