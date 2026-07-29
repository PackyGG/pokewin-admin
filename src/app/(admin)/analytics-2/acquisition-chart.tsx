"use client";

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowDownToLine,
  Sparkles,
  UserPlus,
  UsersRound,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import type { AcquisitionTrendPoint } from "@/lib/queries/analytics-2";

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
    <div className="min-w-52 rounded-xl border bg-popover/95 p-3 text-xs shadow-xl backdrop-blur">
      <p className="mb-2 font-medium text-foreground">
        {formatLongDate(label)}
      </p>
      <div className="space-y-1.5">
        {orderedKeys.map((key) => (
          <div key={key} className="flex items-center justify-between gap-6">
            <span className="flex items-center gap-2 text-muted-foreground">
              <span
                className="size-2 rounded-full"
                style={{ backgroundColor: chartConfig[key].color }}
              />
              {chartConfig[key].label}
            </span>
            <span className="font-mono font-semibold tabular-nums text-foreground">
              {(byKey.get(key) ?? 0).toLocaleString("en-US")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  total,
  icon: Icon,
  accent,
}: {
  label: string;
  value: number;
  total: number;
  icon: typeof UserPlus;
  accent: "blue" | "emerald" | "violet";
}) {
  const accentClass = {
    blue: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    emerald: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    violet: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  }[accent];

  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-4 sm:px-5">
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-xl",
          accentClass,
        )}
      >
        <Icon className="size-4" aria-hidden />
      </div>
      <div className="min-w-0">
        <p className="truncate text-xs font-medium text-muted-foreground">
          {label}
        </p>
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-2xl font-semibold tracking-tight tabular-nums">
            {value.toLocaleString("en-US")}
          </span>
          <span className="truncate text-[11px] text-muted-foreground">
            {total.toLocaleString("en-US")} total
          </span>
        </div>
      </div>
    </div>
  );
}

export function AcquisitionChart({
  data,
}: {
  data: AcquisitionTrendPoint[];
}) {
  const latest = data.at(-1) ?? {
    date: "",
    signups: 0,
    ftds: 0,
    existingDepositors: 0,
  };
  const totals = data.reduce(
    (sum, point) => ({
      signups: sum.signups + point.signups,
      ftds: sum.ftds + point.ftds,
      existingDepositors:
        sum.existingDepositors + point.existingDepositors,
    }),
    { signups: 0, ftds: 0, existingDepositors: 0 },
  );

  return (
    <Card className="overflow-hidden border-border/70 shadow-sm">
      <CardHeader className="gap-4 border-b px-4 py-5 sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" aria-hidden />
            <h2 className="font-semibold tracking-tight">
              Daily acquisition pulse
            </h2>
          </div>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            New accounts, first-time depositors, and returning depositors in
            daily UTC buckets.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60 motion-reduce:animate-none" />
            <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
          </span>
          Today so far
        </div>
      </CardHeader>

      <div className="grid divide-y border-b sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        <Metric
          label="Sign-ups"
          value={latest.signups}
          total={totals.signups}
          icon={UserPlus}
          accent="blue"
        />
        <Metric
          label="First-time depositors"
          value={latest.ftds}
          total={totals.ftds}
          icon={ArrowDownToLine}
          accent="emerald"
        />
        <Metric
          label="Existing depositors"
          value={latest.existingDepositors}
          total={totals.existingDepositors}
          icon={UsersRound}
          accent="violet"
        />
      </div>

      <CardContent className="px-2 pb-4 pt-5 sm:px-5 sm:pb-5">
        <ChartContainer
          config={chartConfig}
          className="aspect-auto h-[330px] w-full sm:h-[390px]"
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
            <CartesianGrid vertical={false} strokeDasharray="3 4" />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={12}
              minTickGap={28}
              tickFormatter={formatDate}
            />
            <YAxis
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              tickMargin={10}
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
              strokeWidth={2.25}
              dot={false}
              activeDot={{ r: 4 }}
              animationDuration={650}
              animationEasing="ease-out"
            />
            <Line
              type="monotone"
              dataKey="signups"
              stroke="var(--color-signups)"
              strokeWidth={2.25}
              dot={false}
              activeDot={{ r: 4 }}
              animationDuration={650}
              animationEasing="ease-out"
            />
            <Line
              type="monotone"
              dataKey="ftds"
              stroke="var(--color-ftds)"
              strokeWidth={2.25}
              dot={false}
              activeDot={{ r: 4 }}
              animationDuration={650}
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
                className="size-2 rounded-full"
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
