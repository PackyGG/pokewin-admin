"use client";

import {
  Bar,
  CartesianGrid,
  Line,
  XAxis,
  YAxis,
  ReferenceLine,
  ComposedChart,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
} from "@/components/ui/chart";
import { formatCompactUsd } from "@/lib/utils/format";

type Point = {
  date: string;
  ggr: number;
  cost: number;
  pnl: number;
};

/**
 * Daily GGR vs total cost vs net P&L over the active window.
 *
 * GGR is the gross margin captured; cost is everything that flowed out
 * of it that day (gameplay givebacks beyond GGR + liabilities +
 * residual = GGR − P&L); P&L is what survived. Lets the operator see if
 * leakage is GROWING relative to GGR over time.
 *
 * House-POV colors, consistent with the Money Flow tab so the two
 * surfaces read together: GGR = blue (the identity line), P&L = emerald
 * (house gain), cost = rose (money back to users). The cost bar sits
 * under the GGR line so the visible headroom between the bar top and
 * the GGR line is the day's P&L.
 */
const chartConfig = {
  ggr: { label: "GGR", color: "rgb(59 130 246)" },
  cost: { label: "Cost (back to users)", color: "rgb(244 63 94)" },
  pnl: { label: "Net P&L", color: "rgb(16 185 129)" },
} satisfies ChartConfig;

export function CostTrendChart({ data }: { data: Point[] }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium">
          GGR vs total cost vs net P&L — daily
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          Cost (rose) is what flowed out of GGR each day. The gap between the
          GGR line and the cost bar is the day&apos;s realized P&L.
        </p>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="h-[280px] w-full">
          <ComposedChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              tickFormatter={(v) => String(v).slice(5)}
              fontSize={10}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={6}
              width={56}
              tickFormatter={formatCompactUsd}
              fontSize={10}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => `$${Number(value).toFixed(2)}`}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <ReferenceLine y={0} stroke="rgb(120 120 120)" strokeDasharray="3 3" />
            <Bar
              dataKey="cost"
              fill="rgb(244 63 94)"
              fillOpacity={0.55}
              animationDuration={700}
              animationEasing="ease-out"
              radius={[3, 3, 0, 0]}
            />
            <Line
              type="monotone"
              dataKey="ggr"
              stroke="rgb(59 130 246)"
              strokeWidth={2}
              dot={false}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Line
              type="monotone"
              dataKey="pnl"
              stroke="rgb(16 185 129)"
              strokeWidth={2}
              dot={false}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </ComposedChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
