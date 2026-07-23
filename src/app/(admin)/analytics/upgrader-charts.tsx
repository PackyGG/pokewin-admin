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
import { ArrowUpCircle, TrendingUp } from "lucide-react";
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
import type { UpgraderDailyPoint } from "@/lib/queries/analytics-upgrader";

// Volume bars — neutral cyan (an activity measure, not a P&L sign), matching
// the Upgrader accent used by the tab's section heading.
const volumeConfig = {
  wager: { label: "Wagered", color: "#06b6d4" }, // cyan-500
} satisfies ChartConfig;

// P&L bars are colored per-bucket by sign (House POV): house up = emerald,
// house down = rose. The cumulative line is a fixed cyan so it reads as a
// running total independent of any single day's sign. Cell fills override the
// bar config, but ChartContainer still needs a config entry per dataKey —
// same convention as the Double Down and dashboard Daily P&L charts.
const pnlConfig = {
  pnl: { label: "House P&L" },
  cumPnl: { label: "Cumulative P&L", color: "#06b6d4" }, // cyan-500
} satisfies ChartConfig;

const PNL_UP = "#10b981"; // emerald-500 — house in profit this day
const PNL_DOWN = "#f43f5e"; // rose-500 — house down this day

/**
 * Pretty-print the "yyyy-MM-dd" UTC day key → "MMM d" for the X axis, without
 * pulling a date lib into this client component (same helper as the other
 * daily charts, e.g. double-down-charts).
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
 * House-POV tooltip for the P&L chart: house profit reads emerald with a
 * leading "+", house loss reads rose with a leading "−". Wager and payout ride
 * along so a spike is readable without hovering a second chart — payout is the
 * player's money back, so it stays rose regardless of the day's net.
 */
function PnlTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ payload?: UpgraderDailyPoint }>;
  label?: string | number;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0]?.payload;
  if (!p) return null;
  return (
    <div className="grid min-w-48 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <div className="font-medium">{formatTick(String(label ?? p.bucket))}</div>
      <div className="grid gap-1">
        {([
          { label: "House P&L", value: p.pnl, signed: true },
          { label: "Cumulative", value: p.cumPnl, signed: true },
          { label: "Wagered", value: p.wager, signed: false },
          { label: "Paid out", value: p.payout, signed: false },
        ] as const).map((r) => {
          // Signed rows take the House-POV colour from their sign. The raw
          // legs are fixed: wager is money in (emerald), payout is money back
          // to the player (rose).
          const tone = r.signed
            ? r.value >= 0
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400"
            : r.label === "Wagered"
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400";
          return (
            <div
              key={r.label}
              className="flex items-center justify-between gap-3"
            >
              <span className="text-muted-foreground">{r.label}</span>
              <span
                className={cn("font-mono font-medium tabular-nums", tone)}
              >
                {r.signed ? (r.value >= 0 ? "+" : "−") : ""}
                {formatCurrency(Math.abs(r.value))}
              </span>
            </div>
          );
        })}
        <div className="flex items-center justify-between gap-3 border-t pt-1">
          <span className="text-muted-foreground">Bets</span>
          <span className="font-mono font-medium tabular-nums">{p.bets}</span>
        </div>
      </div>
    </div>
  );
}

/**
 * The two Upgrader trend charts. Receives a plain serializable array (no
 * function props cross the RSC boundary — Next 15 crashes on those).
 *
 *   A — Volume: wagered per day. Cyan; an activity measure, not a P&L sign.
 *   B — House P&L: net house margin per day, House-POV coloured
 *       (profit emerald / loss rose), plus a cumulative line so a bad day is
 *       readable against the run.
 *
 * Recharts house convention: animationDuration=700, ease-out; reduced motion
 * is respected globally by the chart primitives; dark mode via ChartContainer.
 */
export function UpgraderCharts({ data }: { data: UpgraderDailyPoint[] }) {
  const empty = data.length === 0;

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {/* Graph A — Volume wagered over time. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <ArrowUpCircle className="size-4 text-cyan-500" />
            Volume — wagered over time
          </CardTitle>
          <CardDescription className="text-xs">
            Total staked on the upgrader per day.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {empty ? (
            <EmptyChart />
          ) : (
            <ChartContainer
              config={volumeConfig}
              className="aspect-auto h-[200px] w-full md:h-[220px]"
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
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      labelFormatter={(label) => formatTick(String(label))}
                    />
                  }
                />
                <Bar
                  dataKey="wager"
                  fill="var(--color-wager)"
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
            Wagered − paid out per day. Green = house profit, red = house loss;
            the cyan line is the running cumulative P&amp;L.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {empty ? (
            <EmptyChart />
          ) : (
            <ChartContainer
              config={pnlConfig}
              className="aspect-auto h-[200px] w-full md:h-[220px]"
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
                    <Cell key={d.bucket} fill={d.pnl >= 0 ? PNL_UP : PNL_DOWN} />
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
    <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground md:h-[220px]">
      No upgrader plays in this window.
    </div>
  );
}
