"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatNumber } from "@/lib/utils/format";
import { type HubSignupsFtdsChartRow } from "../_queries/hub-types";

const config = {
  signups: {
    label: "Sign-ups",
    color: "#3b82f6",
  },
  ftds: {
    label: "FTDs",
    color: "#64748b",
  },
} satisfies ChartConfig;

export function HubSignupsFtdsChart({
  data,
  title = "Sign-ups & FTDs (30 days)",
}: {
  data: HubSignupsFtdsChartRow[];
  title?: string;
}) {
  const signupTotal = data.reduce((sum, d) => sum + d.signups, 0);
  const ftdTotal = data.reduce((sum, d) => sum + d.ftds, 0);

  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium">{title}</CardTitle>
          <span className="text-xs text-muted-foreground tabular-nums">
            {formatNumber(signupTotal)} sign-ups · {formatNumber(ftdTotal)} FTDs
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <ChartContainer
          config={config}
          className="aspect-auto h-[220px] w-full md:h-[260px] lg:h-[300px]"
        >
          <BarChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => String(v).slice(5)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              allowDecimals={false}
            />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar
              dataKey="signups"
              fill="var(--color-signups)"
              radius={[4, 4, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="ftds"
              fill="var(--color-ftds)"
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
