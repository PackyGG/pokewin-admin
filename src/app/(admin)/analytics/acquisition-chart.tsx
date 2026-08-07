"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart";
import type { AcquisitionTrendPoint } from "@/lib/queries/analytics-acquisition";

const chartConfig = {
  signups: {
    label: "Sign-ups",
    color: "var(--color-chart-1)",
  },
  ftds: {
    label: "FTDs",
    color: "var(--color-chart-2)",
  },
  existingDepositors: {
    label: "Existing depositors",
    color: "var(--color-chart-3)",
  },
} satisfies ChartConfig;

type TooltipEntry = {
  dataKey?: string | number;
  value?: string | number;
  color?: string;
  payload?: AcquisitionTrendPoint;
};

const shortDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const longDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

function formatDate(value: string): string {
  return shortDateFormatter.format(new Date(`${value}T00:00:00Z`));
}

function formatLongDate(value: string): string {
  return longDateFormatter.format(new Date(`${value}T00:00:00Z`));
}

function AcquisitionTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
}) {
  if (!active || !payload?.length || !label) return null;

  const orderedKeys = ["signups", "ftds", "existingDepositors"] as const;
  const byKey = new Map(
    payload.map((entry) => [String(entry.dataKey), Number(entry.value ?? 0)]),
  );

  return (
    <div className="min-w-52 rounded-lg border bg-popover p-3 text-xs shadow-md">
      <p className="mb-2 font-medium text-foreground">
        {formatLongDate(label)}
      </p>
      <div className="space-y-1.5">
        {orderedKeys.map((key) => (
          <div key={key} className="flex items-center justify-between gap-6">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span
                className="h-2.5 w-2.5 rounded-[2px]"
                style={{ backgroundColor: chartConfig[key].color }}
              />
              {chartConfig[key].label}
            </span>
            <span className="font-mono font-medium tabular-nums text-foreground">
              {(byKey.get(key) ?? 0).toLocaleString("en-US")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AcquisitionChart({
  data,
}: {
  data: AcquisitionTrendPoint[];
}) {
  return (
    <Card>
      <CardContent>
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-[220px] w-full md:h-[260px] lg:h-[300px]"
        >
          <ComposedChart
            data={data}
            accessibilityLayer
            margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
          >
            <defs>
              <linearGradient
                id="existingDepositorsFill"
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop
                  offset="5%"
                  stopColor="var(--color-existingDepositors)"
                  stopOpacity={0.28}
                />
                <stop
                  offset="95%"
                  stopColor="var(--color-existingDepositors)"
                  stopOpacity={0.02}
                />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={28}
              tickFormatter={formatDate}
            />
            <YAxis
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={40}
            />
            <ChartTooltip
              cursor={{ stroke: "var(--border)", strokeDasharray: "4 4" }}
              content={<AcquisitionTooltip />}
            />
            <Area
              type="monotone"
              dataKey="existingDepositors"
              fill="url(#existingDepositorsFill)"
              stroke="var(--color-existingDepositors)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Line
              type="monotone"
              dataKey="signups"
              stroke="var(--color-signups)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Line
              type="monotone"
              dataKey="ftds"
              stroke="var(--color-ftds)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </ComposedChart>
        </ChartContainer>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
          {(
            [
              ["signups", "Sign-ups"],
              ["ftds", "FTDs"],
              ["existingDepositors", "Existing depositors"],
            ] as const
          ).map(([key, label]) => (
            <span key={key} className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 rounded-[2px]"
                style={{ backgroundColor: chartConfig[key].color }}
              />
              {label}
            </span>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
