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

type DailyData = {
  date: string;
  ggr: number;
  ngr: number;
  packWager: number;
  battleWager: number;
  uniqueVisitors: number;
  newSignups: number;
  avgDeposit: number;
  avgBet: number;
  totalDeposit: number;
  totalBet: number;
  minDeposit: number;
  maxDeposit: number;
  minBet: number;
  maxBet: number;
  rewardRakeback: number;
  rewardSignupPacks: number;
  rewardLeaderboard: number;
  rewardRain: number;
  rewardPromo: number;
  rewardAffiliate: number;
};

type AvgTooltipPayload = {
  payload?: DailyData;
};

function AvgTooltip({
  active,
  payload,
  label,
  kind,
}: {
  active?: boolean;
  payload?: AvgTooltipPayload[];
  label?: string;
  kind: "deposit" | "bet";
}) {
  if (!active || !payload?.length || !payload[0]?.payload) return null;
  const d = payload[0].payload;
  const avg = kind === "deposit" ? d.avgDeposit : d.avgBet;
  const total = kind === "deposit" ? d.totalDeposit : d.totalBet;
  const min = kind === "deposit" ? d.minDeposit : d.minBet;
  const max = kind === "deposit" ? d.maxDeposit : d.maxBet;
  const fmt = (v: number) =>
    `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-lg">
      <div className="mb-1.5 font-medium">{label}</div>
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-muted-foreground">
        <span>Median</span>
        <span className="text-right font-semibold tabular-nums text-foreground">
          {fmt(avg)}
        </span>
        <span>Total</span>
        <span className="text-right font-semibold tabular-nums text-foreground">
          {fmt(total)}
        </span>
        <span>Highest</span>
        <span className="text-right tabular-nums text-foreground">
          {fmt(max)}
        </span>
        <span>Lowest</span>
        <span className="text-right tabular-nums text-foreground">
          {fmt(min)}
        </span>
      </div>
    </div>
  );
}

const revenueConfig = {
  ggr: { label: "GGR", color: "var(--color-chart-1)" },
  ngr: { label: "NGR", color: "var(--color-chart-2)" },
} satisfies ChartConfig;

const wagersConfig = {
  packWager: { label: "Pack Wagers", color: "var(--color-chart-3)" },
  battleWager: { label: "Battle Wagers", color: "var(--color-chart-4)" },
} satisfies ChartConfig;

const usersConfig = {
  uniqueVisitors: { label: "Unique Visitors", color: "var(--color-chart-1)" },
  newSignups: { label: "New Signups", color: "var(--color-chart-5)" },
} satisfies ChartConfig;

const avgDepositConfig = {
  avgDeposit: { label: "Avg Deposit", color: "var(--color-chart-2)" },
} satisfies ChartConfig;

const avgBetConfig = {
  avgBet: { label: "Avg Bet", color: "var(--color-chart-4)" },
} satisfies ChartConfig;

const rewardPayoutsConfig = {
  rewardRakeback: { label: "Rakeback", color: "var(--color-chart-1)" },
  rewardSignupPacks: { label: "Signup Packs", color: "var(--color-chart-2)" },
  rewardLeaderboard: { label: "Leaderboard", color: "var(--color-chart-3)" },
  rewardRain: { label: "Rain", color: "var(--color-chart-4)" },
  rewardPromo: { label: "Promo Codes", color: "var(--color-chart-5)" },
} satisfies ChartConfig;

const affiliateConfig = {
  rewardAffiliate: { label: "Affiliate Payouts", color: "var(--color-chart-3)" },
} satisfies ChartConfig;

const currencyFormatter = (v: number) => {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v}`;
};

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

export function AnalyticsCharts({ data }: { data: DailyData[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {/* Revenue Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Revenue (GGR & NGR)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={revenueConfig} className="h-[300px] w-full">
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

      {/* Wagers Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Wagers (Pack & Battle)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={wagersConfig} className="h-[300px] w-full">
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

      {/* Avg Deposit */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Avg Deposit <span className="text-xs font-normal text-muted-foreground">(median, outlier-resistant)</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={avgDepositConfig} className="h-[300px] w-full">
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
              <ChartTooltip content={<AvgTooltip kind="deposit" />} />
              <Line
                type="monotone"
                dataKey="avgDeposit"
                stroke="var(--color-avgDeposit)"
                strokeWidth={2}
                dot={false}
                animationDuration={700}
                animationEasing="ease-out"
              />
            </LineChart>
          </ChartContainer>
        </CardContent>
      </Card>

      {/* Avg Bet */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Avg Bet <span className="text-xs font-normal text-muted-foreground">(median, outlier-resistant)</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={avgBetConfig} className="h-[300px] w-full">
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
              <ChartTooltip content={<AvgTooltip kind="bet" />} />
              <Line
                type="monotone"
                dataKey="avgBet"
                stroke="var(--color-avgBet)"
                strokeWidth={2}
                dot={false}
                animationDuration={700}
                animationEasing="ease-out"
              />
            </LineChart>
          </ChartContainer>
        </CardContent>
      </Card>

      {/* Reward Payouts — stacked bars per category */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Reward Payouts
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer
            config={rewardPayoutsConfig}
            className="h-[300px] w-full"
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

      {/* Affiliate Payouts — separate chart, affiliate claims aren't rewards */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Affiliate Payouts
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer
            config={affiliateConfig}
            className="h-[300px] w-full"
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
                dataKey="rewardAffiliate"
                fill="var(--color-rewardAffiliate)"
                radius={[4, 4, 0, 0]}
                animationDuration={700}
                animationEasing="ease-out"
              />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>

      {/* Users — moved to last position so the Avg Bet / Reward Payouts /
          Affiliate Payouts row is complete above it (all three chart cells
          on the same grid row per admin request). */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">
            Users (Visitors & Signups)
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ChartContainer config={usersConfig} className="h-[300px] w-full">
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
                width={50}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Line
                type="monotone"
                dataKey="uniqueVisitors"
                stroke="var(--color-uniqueVisitors)"
                strokeWidth={2}
                dot={false}
                animationDuration={700}
                animationEasing="ease-out"
              />
              <Line
                type="monotone"
                dataKey="newSignups"
                stroke="var(--color-newSignups)"
                strokeWidth={2}
                dot={false}
                animationDuration={700}
                animationEasing="ease-out"
              />
            </LineChart>
          </ChartContainer>
        </CardContent>
      </Card>
    </div>
  );
}
