"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
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

// Rose-500 — house spends money on creators = a house cost (House-POV).
// Same semantic rose the main dashboard uses for house-down figures. The hex
// lives ONLY here in the config; every chart element reads the
// ChartContainer-generated `var(--color-cost)` token.
const config = {
  cost: {
    label: "Creator cost",
    color: "#f43f5e", // rose-500
  },
} satisfies ChartConfig;

export type CreatorCostChartPoint = {
  /** Display label for the x-axis tick (e.g. "06-23" or "14:00"). */
  bucket: string;
  /** Decimal-safe USD cost for this bucket. */
  cost: number;
};

/**
 * Creator-cost time series — a single ROSE area chart. House-POV: every
 * dollar plotted is money the house paid out to creators (converted deal
 * payouts + tips + leaderboard prize gross). Rose at every layer — line,
 * gradient fill, tooltip amount.
 *
 * Each bucket's `cost` should already be Decimal-safe (Number — `toNumber`
 * was applied server-side). The chart never formats Float arithmetic; it
 * just renders the supplied numbers via the shared `formatCurrency` /
 * `formatCompactUsd` helpers.
 */
export function HubCreatorCostChart({
  data,
  title = "Creator costs",
  subtitle,
  hourlyXAxis = false,
}: {
  data: CreatorCostChartPoint[];
  title?: string;
  subtitle?: string;
  hourlyXAxis?: boolean;
}) {
  const total = data.reduce((sum, p) => sum + p.cost, 0);
  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          <span className="font-mono text-xs font-semibold tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(total)}
          </span>
        </div>
        {subtitle ? (
          <CardDescription className="text-xs">{subtitle}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={config}
          className="aspect-auto h-[220px] w-full md:h-[260px] lg:h-[300px]"
        >
          <AreaChart data={data} accessibilityLayer>
            <defs>
              <linearGradient id="creatorCostFill" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  stopColor="var(--color-cost)"
                  stopOpacity={0.4}
                />
                <stop
                  offset="100%"
                  stopColor="var(--color-cost)"
                  stopOpacity={0.05}
                />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="bucket"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) =>
                hourlyXAxis ? String(v) : String(v).slice(5)
              }
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={70}
              tickFormatter={formatCompactUsd}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => (
                    <div className="flex flex-1 items-center justify-between gap-4 leading-none">
                      <span className="text-muted-foreground">
                        Creator cost
                      </span>
                      <span className="font-mono font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                        {formatCurrency(Number(value))}
                      </span>
                    </div>
                  )}
                />
              }
            />
            <Area
              type="monotone"
              dataKey="cost"
              stroke="var(--color-cost)"
              strokeWidth={2}
              fill="url(#creatorCostFill)"
              animationDuration={700}
              animationEasing="ease-out"
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
