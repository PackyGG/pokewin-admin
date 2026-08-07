"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatCompactUsd } from "@/lib/utils/format";

/**
 * Trend charts for the /analytics overview, each fed by the same
 * `getAnalyticsData(period).daily` series the sections above them sum from —
 * so a chart never disagrees with the number beside it.
 *
 * The 2026-08 one-page redesign split the old seven-chart `AnalyticsCharts`
 * monolith into the three that carry the page's argument (revenue, wager mix,
 * reward legs); median-deposit/median-bet/users/affiliate died with it
 * (owner: the page must be usable, not exhaustive — depth lives in the deep
 * dives).
 */

type DailyData = {
  date: string;
  ggr: number;
  ngr: number;
  packWager: number;
  battleWager: number;
  rewardRakeback: number;
  rewardSignupPacks: number;
  rewardLeaderboard: number;
  rewardRain: number;
  rewardPromo: number;
};

const revenueConfig = {
  ggr: { label: "GGR", color: "var(--color-chart-1)" },
  ngr: { label: "NGR", color: "var(--color-chart-2)" },
} satisfies ChartConfig;

const wagersConfig = {
  packWager: { label: "Pack Wagers", color: "var(--color-chart-3)" },
  battleWager: { label: "Battle Wagers", color: "var(--color-chart-4)" },
} satisfies ChartConfig;

const rewardPayoutsConfig = {
  rewardRakeback: { label: "Rakeback", color: "var(--color-chart-1)" },
  rewardSignupPacks: { label: "Signup Packs", color: "var(--color-chart-2)" },
  rewardLeaderboard: { label: "Leaderboard", color: "var(--color-chart-3)" },
  rewardRain: { label: "Rain", color: "var(--color-chart-4)" },
  rewardPromo: { label: "Promo Codes", color: "var(--color-chart-5)" },
} satisfies ChartConfig;

const currencyFormatter = formatCompactUsd;

/**
 * Tooltip row that shows the color indicator, the label from config,
 * and the formatted $ value — used when a chart has multiple series
 * and the admin needs to know which segment they're hovering.
 */
function labeledCurrencyRow(
  value: number | string | (string | number)[],
  name: string | number,
  config: Record<string, { label: string; color: string }>,
) {
  const cfg = config[String(name)];
  const numeric = Array.isArray(value) ? Number(value[0] ?? 0) : Number(value);
  return (
    <>
      <div
        className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
        style={{ backgroundColor: cfg?.color ?? "var(--muted)" }}
      />
      <div className="flex flex-1 items-center justify-between gap-3">
        <span className="text-muted-foreground">{cfg?.label ?? String(name)}</span>
        <span className="font-mono font-medium tabular-nums">
          ${numeric.toFixed(2)}
        </span>
      </div>
    </>
  );
}

/** GGR & NGR per day — the revenue line the headline tiles sum from. */
export function RevenueTrendChart({ data }: { data: DailyData[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Revenue (GGR & NGR)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={revenueConfig}
          className="h-[240px] w-full md:h-[280px]"
        >
          <LineChart data={data} accessibilityLayer>
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
              tickFormatter={currencyFormatter}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => `$${Number(value).toFixed(2)}`}
                />
              }
            />
            <Line
              type="monotone"
              dataKey="ggr"
              stroke="var(--color-ggr)"
              strokeWidth={2}
              dot={false}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Line
              type="monotone"
              dataKey="ngr"
              stroke="var(--color-ngr)"
              strokeWidth={2}
              dot={false}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </LineChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/** Pack vs battle wager per day, stacked — the mix behind the revenue line. */
export function WagerMixChart({ data }: { data: DailyData[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Wagers (Pack & Battle)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={wagersConfig}
          className="h-[240px] w-full md:h-[280px]"
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
              tickFormatter={currencyFormatter}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => `$${Number(value).toFixed(2)}`}
                />
              }
            />
            <Bar
              dataKey="packWager"
              fill="var(--color-packWager)"
              stackId="wagers"
              radius={[0, 0, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="battleWager"
              fill="var(--color-battleWager)"
              stackId="wagers"
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

/** The five reward legs per day, stacked — the daily shape of the cost stack. */
export function RewardLegsChart({ data }: { data: DailyData[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Reward Payouts</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={rewardPayoutsConfig}
          className="h-[240px] w-full md:h-[280px]"
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
              tickFormatter={currencyFormatter}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value, name) =>
                    labeledCurrencyRow(value, name, rewardPayoutsConfig)
                  }
                />
              }
            />
            <Bar
              dataKey="rewardRakeback"
              stackId="rewards"
              fill="var(--color-rewardRakeback)"
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="rewardSignupPacks"
              stackId="rewards"
              fill="var(--color-rewardSignupPacks)"
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="rewardLeaderboard"
              stackId="rewards"
              fill="var(--color-rewardLeaderboard)"
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="rewardRain"
              stackId="rewards"
              fill="var(--color-rewardRain)"
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="rewardPromo"
              stackId="rewards"
              fill="var(--color-rewardPromo)"
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
