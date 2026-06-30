"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis, Cell } from "recharts";
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
import { formatCompactUsd } from "@/lib/utils/format";
import type { DoubleDownTimeSeriesPoint } from "@/lib/queries/double-down-shared";

// Usage bars — neutral purple (engagement count, not money), matching the
// page's Double Down accent.
const usageConfig = {
  started: { label: "Rounds", color: "#a855f7" }, // purple-500
} satisfies ChartConfig;

// P&L bars are colored per-bucket by sign (House-POV): house up = emerald,
// house down = rose. Cell fills override the config, but ChartContainer still
// needs a config entry for the dataKey. Same convention as the dashboard's
// Daily P&L chart (PNL_UP / PNL_DOWN).
const pnlConfig = {
  pnl: { label: "House P&L" },
} satisfies ChartConfig;

const PNL_UP = "#10b981"; // emerald-500 — house in profit this hour
const PNL_DOWN = "#f43f5e"; // rose-500 — house down this hour

/**
 * The two stacked Double Down charts for the RIGHT half of
 * /insights/double-down. Receives a plain serializable array of hourly
 * buckets (no function props cross the RSC boundary). HOURLY buckets — the
 * feature is only a few days old + tiny volume, so daily would be 1-2 bars.
 *
 *   A — Usage: count of STARTED rounds per hour (how many battles used double
 *       down over time). Neutral purple.
 *   B — House P&L: net house P&L per hour (staked − real voucher payout),
 *       House-POV colored (profit emerald / loss rose).
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
            Started Double Down rounds per hour (UTC).
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
              <BarChart data={data} accessibilityLayer>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="bucket"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  width={32}
                  allowDecimals={false}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar
                  dataKey="started"
                  fill="var(--color-started)"
                  radius={[4, 4, 0, 0]}
                  animationDuration={700}
                  animationEasing="ease-out"
                />
              </BarChart>
            </ChartContainer>
          )}
        </CardContent>
      </Card>

      {/* Graph B — House P&L over time. */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <TrendingUp className="size-4 text-emerald-500" />
            House P&amp;L over time
          </CardTitle>
          <CardDescription className="text-xs">
            Net house P&amp;L per hour (staked − payout). Green = house profit,
            red = house loss.
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
              <BarChart data={data} accessibilityLayer>
                <CartesianGrid vertical={false} />
                <XAxis
                  dataKey="bucket"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  width={52}
                  tickFormatter={formatCompactUsd}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
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
              </BarChart>
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
