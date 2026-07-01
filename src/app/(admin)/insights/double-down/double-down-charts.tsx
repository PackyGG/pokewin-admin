"use client";

import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";
import { Dices, TrendingUp } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";
import type { DoubleDownTimeSeriesPoint } from "@/lib/queries/double-down-shared";

// Usage bars — neutral purple (engagement count, not money), matching the
// page's Double Down accent.
const usageConfig = {
  started: { label: "Rounds", color: "#a855f7" }, // purple-500
} satisfies ChartConfig;

// P&L bars are colored per-bucket by sign (House-POV): house up = emerald,
// house down = rose. The cumulative line uses a fixed cyan so it reads as a
// running total independent of any single day's sign. Cell fills override the
// bar config, but ChartContainer still needs a config entry per dataKey. Same
// convention as the dashboard's Daily P&L chart (PNL_UP / PNL_DOWN).
const pnlConfig = {
  pnl: { label: "House P&L" },
  cumPnl: { label: "Cumulative P&L", color: "#06b6d4" }, // cyan-500
} satisfies ChartConfig;

const PNL_UP = "#10b981"; // emerald-500 — house in profit this day
const PNL_DOWN = "#f43f5e"; // rose-500 — house down this day

/**
 * Pretty-print the "yyyy-MM-dd" UTC day key → "MMM d" for the X axis, without
 * pulling a date lib into this client component (same helper as the other
 * daily insights charts, e.g. race daily-prize-chart).
 */
function formatTick(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * House-POV tooltip for the Double Down P&L chart. Signs + colors both the
 * day's net P&L and the running cumulative P&L from the HOUSE perspective:
 * house profit reads emerald with a leading "+", house loss reads rose with a
 * leading "−". Mirrors the dashboard Daily P&L tooltip's convention.
 */
function PnlTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ payload?: DoubleDownTimeSeriesPoint }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  const rows: Array<{ label: string; value: number }> = [
    { label: "House P&L", value: p.pnl },
    { label: "Cumulative", value: p.cumPnl },
  ];
  return (
    <div className="grid min-w-44 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{formatTick(String(label ?? p.bucket))}</div>
      <div className="grid gap-1">
        {rows.map((r) => {
          const positive = r.value >= 0;
          return (
            <div key={r.label} className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">{r.label}</span>
              <span
                className={cn(
                  "font-mono font-medium tabular-nums",
                  positive
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-rose-600 dark:text-rose-400",
                )}
              >
                {positive ? "+" : "−"}
                {formatCurrency(Math.abs(r.value))}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The two stacked Double Down charts for the RIGHT half of
 * /insights/double-down. Receives a plain serializable array of daily buckets
 * (no function props cross the RSC boundary). DAILY buckets — the page is
 * locked to a 30d window, so one bar per day with a clean "MMM d" X-axis.
 *
 *   A — Usage: count of STARTED rounds per day (how many battles used double
 *       down over time). Neutral purple.
 *   B — House P&L: net house P&L per day (staked − real voucher payout),
 *       House-POV colored (profit emerald / loss rose), plus a cumulative
 *       House-P&L line (cyan running total) and a House-POV signed tooltip.
 *
 * Recharts house convention: animationDuration=700, ease-out; reduced-motion
 * is respected globally by the chart primitives; dark-mode via ChartContainer.
 */
export function DoubleDownCharts({
  data,
}: {
  data: DoubleDownTimeSeriesPoint[];
}) {
  const empty = data.length === 0;

  return (
    <div className="flex h-full flex-col gap-4">
      {/* Graph A — Usage (rounds over time). */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Dices className="size-4 text-purple-500" />
            Usage — rounds over time
          </CardTitle>
          <CardDescription className="text-xs">
            Started Double Down rounds per day.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {empty ? (
            <EmptyChart />
          ) : (
            <ChartContainer
              config={usageConfig}
              className="aspect-auto h-[180px] w-full md:h-[200px]"
            >
              <ComposedChart data={data} accessibilityLayer>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="bucket"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tickFormatter={formatTick}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  width={32}
                  allowDecimals={false}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(label) => formatTick(String(label))}
                    />
                  }
                />
                <Bar
                  dataKey="started"
                  fill="var(--color-started)"
                  radius={[4, 4, 0, 0]}
                  animationDuration={700}
                  animationEasing="ease-out"
                />
              </ComposedChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      {/* Graph B — House P&L over time (per-day bars + cumulative line). */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <TrendingUp className="size-4 text-emerald-500" />
            House P&amp;L over time
          </CardTitle>
          <CardDescription className="text-xs">
            Net house P&amp;L per day (staked − payout). Green = house profit,
            red = house loss; the cyan line is the running cumulative P&amp;L.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {empty ? (
            <EmptyChart />
          ) : (
            <ChartContainer
              config={pnlConfig}
              className="aspect-auto h-[180px] w-full md:h-[200px]"
            >
              <ComposedChart data={data} accessibilityLayer>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="bucket"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  tickFormatter={formatTick}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  width={52}
                  tickFormatter={formatCompactUsd}
                />
                <ChartTooltip content={<PnlTooltip />} />
                <Bar
                  dataKey="pnl"
                  radius={[4, 4, 0, 0]}
                  animationDuration={700}
                  animationEasing="ease-out"
                >
                  {data.map((d) => (
                    <Cell
                      key={d.bucket}
                      fill={d.pnl >= 0 ? PNL_UP : PNL_DOWN}
                    />
                  ))}
                </Bar>
                <Line
                  type="monotone"
                  dataKey="cumPnl"
                  stroke="var(--color-cumPnl)"
                  strokeWidth={2}
                  dot={false}
                  animationDuration={700}
                  animationEasing="ease-out"
                />
              </ComposedChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="flex h-[180px] items-center justify-center text-sm text-muted-foreground md:h-[200px]">
      No Double Down rounds in this window.
    </div>
  );
}
