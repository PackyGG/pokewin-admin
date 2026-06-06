"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { LineChart as LineChartIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";
import { type HubChartPoint } from "../_queries/hub-types";

/**
 * Creator Hub dashboard — Wager / Deposits area chart (3-up row).
 * Uses the shared shadcn ChartContainer so axes, grid, and tooltip match
 * the main admin dashboard charts.
 */

export type { HubChartPoint };

const EMERALD = "#34d399";

const chartConfig = {
  value: { label: "Total", color: EMERALD },
} satisfies ChartConfig;

export function HubChartCard({
  title,
  headline,
  series = [],
  placeholderNote,
}: {
  title: string;
  headline: string | null;
  series?: HubChartPoint[];
  placeholderNote?: string;
}) {
  const hasActivity = series.some((p) => p.value > 0);
  const gradientId =
    title === "Deposits" ? "hubDepositsAreaGradient" : "hubWagerAreaGradient";

  return (
    <div className="flex h-full flex-col rounded-2xl border bg-card p-4 sm:p-5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{title}</span>
        <LineChartIcon className="size-4 text-emerald-500" />
      </div>

      <p className="text-2xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
        {headline ?? <span className="text-muted-foreground/60">—</span>}
      </p>

      <div className="mt-3 min-h-[172px] flex-1 w-full">
        {hasActivity ? (
          <ChartContainer
            config={chartConfig}
            className="aspect-auto h-[172px] w-full"
          >
            <AreaChart
              data={series}
              margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              accessibilityLayer
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={EMERALD} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={EMERALD} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                fontSize={10}
                minTickGap={28}
                interval="preserveStartEnd"
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={4}
                width={52}
                fontSize={10}
                tickFormatter={formatCompactUsd}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) => formatCurrency(Number(value))}
                    hideIndicator
                  />
                }
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={EMERALD}
                fill={`url(#${gradientId})`}
                strokeWidth={2}
                animationDuration={700}
                animationEasing="ease-out"
                dot={false}
                activeDot={{ r: 3, strokeWidth: 0 }}
              />
            </AreaChart>
          </ChartContainer>
        ) : (
          <div className="relative flex h-[172px] w-full flex-col">
            <div
              aria-hidden
              className="flex-1 rounded-md border border-dashed border-border/60 bg-[linear-gradient(to_bottom,transparent_calc(50%-0.5px),var(--border)_50%,transparent_calc(50%+0.5px)),linear-gradient(to_bottom,transparent_calc(25%-0.5px),color-mix(in_oklab,var(--border)_50%,transparent)_25%,transparent_calc(25%+0.5px)),linear-gradient(to_bottom,transparent_calc(75%-0.5px),color-mix(in_oklab,var(--border)_50%,transparent)_75%,transparent_calc(75%+0.5px))]"
            />
            <p
              className={cn(
                "pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-[11px] text-muted-foreground",
              )}
            >
              {placeholderNote ?? "No activity in this window yet."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
