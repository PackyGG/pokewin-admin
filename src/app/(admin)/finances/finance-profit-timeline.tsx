"use client";

import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
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
} from "@/components/ui/chart";
import type { FinanceProfitTimelinePoint } from "@/lib/finances/profit-timeline";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";

const chartConfig = {
  cashPnl: { label: "Cash P&L", color: "#3b82f6" },
  costBar: { label: "Operating costs", color: "#f43f5e" },
  netProfit: { label: "Daily net", color: "#10b981" },
  cumulativeProfit: { label: "Cumulative net", color: "#f59e0b" },
} satisfies ChartConfig;

type ChartPoint = FinanceProfitTimelinePoint & { costBar: number };
type TooltipEntry = { dataKey?: string | number; payload?: ChartPoint };

const shortDate = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const longDate = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function dateLabel(date: string, long = false): string {
  const value = new Date(`${date}T00:00:00Z`);
  return (long ? longDate : shortDate).format(value);
}

function ProfitTimelineTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point || !label) return null;

  const rows = [
    ["Cash P&L", point.cashPnl, "text-blue-500"],
    ["Salary", -point.salaryCost, "text-rose-500"],
    ["Subscriptions", -point.subscriptionCost, "text-rose-500"],
    ["Logged expenses", -point.oneTimeCost, "text-rose-500"],
    [
      "Daily net",
      point.netProfit,
      point.netProfit >= 0 ? "text-emerald-500" : "text-rose-500",
    ],
    [
      "Cumulative net",
      point.cumulativeProfit,
      point.cumulativeProfit >= 0 ? "text-emerald-500" : "text-rose-500",
    ],
  ] as const;

  return (
    <div className="min-w-60 rounded-lg border bg-popover p-3 text-xs shadow-md">
      <p className="mb-2 font-medium text-foreground">
        {dateLabel(label, true)}
      </p>
      <div className="space-y-1.5">
        {rows.map(([name, value, className]) => (
          <div key={name} className="flex items-center justify-between gap-6">
            <span className="text-muted-foreground">{name}</span>
            <span className={`font-mono font-medium tabular-nums ${className}`}>
              {value > 0 ? "+" : value < 0 ? "−" : ""}
              {formatCurrency(Math.abs(value))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FinanceProfitTimeline({
  data,
  caption,
}: {
  data: FinanceProfitTimelinePoint[];
  caption: string;
}) {
  const chartData: ChartPoint[] = data.map((point) => ({
    ...point,
    costBar: -point.operatingCosts,
  }));

  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>Profit timeline</CardTitle>
        <CardDescription>
          Daily cash P&amp;L, tracked costs, net result, and running profit ·{" "}
          {caption}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-[260px] w-full lg:h-[330px]"
        >
          <ComposedChart
            data={chartData}
            accessibilityLayer
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
              tickFormatter={(value: string) => dateLabel(value)}
            />
            <YAxis
              yAxisId="daily"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={62}
              tickFormatter={formatCompactUsd}
            />
            <YAxis
              yAxisId="cumulative"
              orientation="right"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={62}
              tickFormatter={formatCompactUsd}
            />
            <ChartTooltip
              cursor={{ stroke: "var(--border)", strokeDasharray: "4 4" }}
              content={<ProfitTimelineTooltip />}
            />
            <ReferenceLine yAxisId="daily" y={0} stroke="var(--border)" />
            <Bar
              yAxisId="daily"
              dataKey="cashPnl"
              fill="var(--color-cashPnl)"
              fillOpacity={0.7}
              radius={[3, 3, 0, 0]}
            />
            <Bar
              yAxisId="daily"
              dataKey="costBar"
              fill="var(--color-costBar)"
              fillOpacity={0.75}
              radius={[0, 0, 3, 3]}
            />
            <Line
              yAxisId="daily"
              type="monotone"
              dataKey="netProfit"
              stroke="var(--color-netProfit)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
            <Line
              yAxisId="cumulative"
              type="monotone"
              dataKey="cumulativeProfit"
              stroke="var(--color-cumulativeProfit)"
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              activeDot={{ r: 4 }}
            />
          </ComposedChart>
        </ChartContainer>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          {Object.entries(chartConfig).map(([key, item]) => (
            <span key={key} className="flex items-center gap-2">
              <span
                className="size-2.5 rounded-[2px]"
                style={{ backgroundColor: item.color }}
              />
              {item.label}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
