"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import { LineChart as LineChartIcon, Users } from "lucide-react";
import { SectionHeading } from "@/components/modern-panels";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatCompactUsd, formatCurrency, formatNumber } from "@/lib/utils/format";

type DailyData = {
  date: string;
  signups: number;
  commission: number;
  wagerVolume: number;
  depositVolume: number;
  clicks: number;
};

// House-POV colors (CLAUDE.md, strict — same hex family the rest of the
// admin uses so the two charts read as one system):
//   • Wager + Deposit volume = money IN from referred users → house income
//     → emerald family. Two distinct emerald shades so the pair stays
//     legible on one chart while both read as "house income".
//   • Commission = money the house PAYS OUT to affiliates → house cost →
//     rose (#f43f5e), the same rose every cost surface uses.
//   • Signups / Clicks = neutral counts (not dollars in or out), so the
//     gain/loss rule doesn't apply — blue for signups (the neutral-event
//     hue) and orange for clicks (matching the "Total Clicks" KpiTile).
const EMERALD = "#10b981"; // emerald-500 — wager volume (house income)
const EMERALD_LIGHT = "#34d399"; // emerald-400 — deposit volume (house income)
const ROSE = "#f43f5e"; // rose-500 — commission paid (house cost)
const BLUE = "#3b82f6"; // blue-500 — signups (neutral event)
const ORANGE = "#f97316"; // orange-500 — clicks (neutral count)

const volumeConfig = {
  wagerVolume: { label: "Wager Volume", color: EMERALD },
  depositVolume: { label: "Deposit Volume", color: EMERALD_LIGHT },
  commission: { label: "Commission", color: ROSE },
} satisfies ChartConfig;

const activityConfig = {
  signups: { label: "Signups", color: BLUE },
  clicks: { label: "Clicks", color: ORANGE },
} satisfies ChartConfig;

/**
 * Modern chart panel — mirrors the house chart-card treatment (rounded-2xl
 * border, glassy sheen, soft corner glow) used across the admin, with a
 * <SectionHeading> header instead of the legacy bare <Card>/<CardHeader>.
 */
function ChartPanel({
  icon,
  title,
  children,
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border bg-card p-4 sm:p-5">
      <SectionHeading icon={icon} title={title} />
      <div className="mt-4">{children}</div>
    </div>
  );
}

export function CreatorAnalyticsCharts({ data }: { data: DailyData[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ChartPanel icon={LineChartIcon} title="Volume & Commission">
        <ChartContainer
          config={volumeConfig}
          className="aspect-auto h-[300px] w-full"
        >
          <AreaChart data={data} margin={{ left: 6, right: 6 }} accessibilityLayer>
            <defs>
              <linearGradient id="creatorWagerGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={EMERALD} stopOpacity={0.3} />
                <stop offset="100%" stopColor={EMERALD} stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="creatorDepositGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={EMERALD_LIGHT} stopOpacity={0.25} />
                <stop offset="100%" stopColor={EMERALD_LIGHT} stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="creatorCommissionGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={ROSE} stopOpacity={0.25} />
                <stop offset="100%" stopColor={ROSE} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v: string) => v.slice(5)}
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
                  formatter={(value) => formatCurrency(Number(value))}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Area
              type="monotone"
              dataKey="wagerVolume"
              stroke={EMERALD}
              fill="url(#creatorWagerGradient)"
              strokeWidth={2}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Area
              type="monotone"
              dataKey="depositVolume"
              stroke={EMERALD_LIGHT}
              fill="url(#creatorDepositGradient)"
              strokeWidth={2}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Area
              type="monotone"
              dataKey="commission"
              stroke={ROSE}
              fill="url(#creatorCommissionGradient)"
              strokeWidth={2}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </AreaChart>
        </ChartContainer>
      </ChartPanel>

      <ChartPanel icon={Users} title="Signups & Clicks">
        <ChartContainer
          config={activityConfig}
          className="aspect-auto h-[300px] w-full"
        >
          <BarChart data={data} margin={{ left: 6, right: 6 }} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v: string) => v.slice(5)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={50}
              tickFormatter={(v: number) => formatNumber(v)}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => formatNumber(Number(value))}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Bar
              dataKey="signups"
              fill={BLUE}
              radius={[4, 4, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="clicks"
              fill={ORANGE}
              radius={[4, 4, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </BarChart>
        </ChartContainer>
      </ChartPanel>
    </div>
  );
}
