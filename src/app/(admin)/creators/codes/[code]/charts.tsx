"use client";

import { useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
} from "@/components/ui/chart";
import { formatCompactUsd } from "@/lib/utils/format";
import { cn } from "@/lib/utils";

type DailyData = {
  date: string;
  referrals: number;
  depositVolume: number;
  wagerVolume: number;
  commission: number;
  clicks: number;
};

type Range = "7d" | "30d" | "90d" | "all";

const RANGE_DAYS: Record<Range, number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};

const RANGE_LABELS: Record<Range, string> = {
  "7d": "7D",
  "30d": "30D",
  "90d": "90D",
  all: "All",
};

const volumeConfig = {
  depositVolume: { label: "Deposits", color: "var(--color-chart-1)" },
  wagerVolume: { label: "Wagers", color: "var(--color-chart-2)" },
  commission: { label: "Commission", color: "var(--color-chart-3)" },
} satisfies ChartConfig;

const activityConfig = {
  referrals: { label: "Signups", color: "var(--color-chart-4)" },
  clicks: { label: "Clicks", color: "var(--color-chart-5)" },
} satisfies ChartConfig;

// Fill missing days inside [from, to] with zeros so the area chart renders
// a continuous baseline instead of jagged spikes between sparse data points.
function fillRange(rows: DailyData[], days: number | null): DailyData[] {
  if (rows.length === 0) return rows;
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const lastDateStr = sorted[sorted.length - 1]!.date;
  const firstDateStr = days
    ? new Date(Date.now() - (days - 1) * 86_400_000).toISOString().split("T")[0]!
    : sorted[0]!.date;

  const byDate = new Map(sorted.map((r) => [r.date, r]));
  const out: DailyData[] = [];
  const cursor = new Date(`${firstDateStr}T00:00:00Z`);
  const end = new Date(`${lastDateStr}T00:00:00Z`);
  while (cursor <= end) {
    const key = cursor.toISOString().split("T")[0]!;
    out.push(
      byDate.get(key) ?? {
        date: key,
        referrals: 0,
        depositVolume: 0,
        wagerVolume: 0,
        commission: 0,
        clicks: 0,
      },
    );
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

// Order matters — controls the row order inside the tooltip and is the
// reverse of the visual stack on the chart so the highest-value series
// (wagers) sits at the top of the readout.
const VOLUME_TOOLTIP_ROWS = [
  { key: "wagerVolume", label: "Wagers", color: "var(--color-chart-2)" },
  { key: "depositVolume", label: "Deposits", color: "var(--color-chart-1)" },
  { key: "commission", label: "Commission", color: "var(--color-chart-3)" },
] as const;

function formatTooltipDate(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatUsd(value: number): string {
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

type VolumeTooltipProps = {
  active?: boolean;
  payload?: Array<{ payload: DailyData }>;
};

function VolumeTooltip({ active, payload }: VolumeTooltipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;

  return (
    <div className="min-w-[220px] rounded-lg border border-border/60 bg-popover px-3 py-2.5 text-xs shadow-xl">
      <div className="mb-2 flex items-center justify-between gap-3 border-b border-border/60 pb-1.5">
        <span className="font-semibold text-foreground">
          {formatTooltipDate(row.date)}
        </span>
        <span className="tabular-nums text-[10px] text-muted-foreground">
          {row.referrals > 0
            ? `${row.referrals} signup${row.referrals === 1 ? "" : "s"}`
            : "no signups"}
        </span>
      </div>
      <div className="space-y-1">
        {VOLUME_TOOLTIP_ROWS.map((r) => {
          const value = (row as unknown as Record<string, number>)[r.key] ?? 0;
          return (
            <div
              key={r.key}
              className="flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-2">
                <span
                  className="size-2.5 shrink-0 rounded-[3px]"
                  style={{ backgroundColor: r.color }}
                />
                <span className="text-muted-foreground">{r.label}</span>
              </div>
              <span
                className={cn(
                  "tabular-nums font-medium",
                  value === 0 && "text-muted-foreground/60",
                )}
              >
                {formatUsd(value)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type ActivityTooltipProps = {
  active?: boolean;
  payload?: Array<{ payload: DailyData }>;
};

function ActivityTooltip({ active, payload }: ActivityTooltipProps) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;

  const cvr = row.clicks > 0 ? (row.referrals / row.clicks) * 100 : null;

  return (
    <div className="min-w-[200px] rounded-lg border border-border/60 bg-popover px-3 py-2.5 text-xs shadow-xl">
      <div className="mb-2 border-b border-border/60 pb-1.5 font-semibold text-foreground">
        {formatTooltipDate(row.date)}
      </div>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-[3px]"
              style={{ backgroundColor: "var(--color-chart-5)" }}
            />
            <span className="text-muted-foreground">Clicks</span>
          </div>
          <span className="tabular-nums font-medium">
            {row.clicks.toLocaleString()}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span
              className="size-2.5 shrink-0 rounded-[3px]"
              style={{ backgroundColor: "var(--color-chart-4)" }}
            />
            <span className="text-muted-foreground">Signups</span>
          </div>
          <span className="tabular-nums font-medium">
            {row.referrals.toLocaleString()}
          </span>
        </div>
      </div>
      {cvr !== null && (
        <div className="mt-2 flex items-center justify-between gap-3 border-t border-border/60 pt-1.5">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Conversion
          </span>
          <span className="tabular-nums font-semibold text-foreground">
            {cvr.toFixed(2)}%
          </span>
        </div>
      )}
    </div>
  );
}

function RangeToggle({
  value,
  onChange,
}: {
  value: Range;
  onChange: (r: Range) => void;
}) {
  return (
    <div className="inline-flex rounded-md border bg-muted/40 p-0.5">
      {(Object.keys(RANGE_LABELS) as Range[]).map((r) => (
        <button
          key={r}
          type="button"
          onClick={() => onChange(r)}
          className={cn(
            "px-2.5 py-1 text-xs font-medium rounded-sm transition-colors",
            value === r
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {RANGE_LABELS[r]}
        </button>
      ))}
    </div>
  );
}

export function CodeAnalyticsCharts({ data }: { data: DailyData[] }) {
  const [range, setRange] = useState<Range>("30d");

  const filtered = useMemo(() => {
    const days = RANGE_DAYS[range];
    if (!days) return fillRange(data, null);
    const cutoff = new Date(Date.now() - days * 86_400_000)
      .toISOString()
      .split("T")[0]!;
    return fillRange(
      data.filter((d) => d.date >= cutoff),
      days,
    );
  }, [data, range]);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm font-medium">Volume & Commission</CardTitle>
          <RangeToggle value={range} onChange={setRange} />
        </CardHeader>
        <CardContent>
          <ChartContainer config={volumeConfig} className="h-[300px] w-full">
            <AreaChart data={filtered} accessibilityLayer>
              <defs>
                <linearGradient id="fillDeposits" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-depositVolume)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="var(--color-depositVolume)" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="fillWagers" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-wagerVolume)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="var(--color-wagerVolume)" stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="fillCommission" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-commission)" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="var(--color-commission)" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                width={70}
                tickFormatter={formatCompactUsd}
              />
              <Tooltip
                cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
                content={<VolumeTooltip />}
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Area
                type="monotone"
                dataKey="wagerVolume"
                stroke="var(--color-wagerVolume)"
                fill="url(#fillWagers)"
                strokeWidth={2}
                animationDuration={700}
                animationEasing="ease-out"
              />
              <Area
                type="monotone"
                dataKey="depositVolume"
                stroke="var(--color-depositVolume)"
                fill="url(#fillDeposits)"
                strokeWidth={2}
                animationDuration={700}
                animationEasing="ease-out"
              />
              <Area
                type="monotone"
                dataKey="commission"
                stroke="var(--color-commission)"
                fill="url(#fillCommission)"
                strokeWidth={2}
                animationDuration={700}
                animationEasing="ease-out"
              />
            </AreaChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-sm font-medium">Signups & Clicks</CardTitle>
          <RangeToggle value={range} onChange={setRange} />
        </CardHeader>
        <CardContent>
          <ChartContainer config={activityConfig} className="h-[300px] w-full">
            <BarChart data={filtered} accessibilityLayer>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={(v: string) => v.slice(5)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                width={50}
              />
              <Tooltip
                cursor={{ fill: "var(--muted)", opacity: 0.4 }}
                content={<ActivityTooltip />}
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar
                dataKey="clicks"
                fill="var(--color-clicks)"
                radius={[4, 4, 0, 0]}
                animationDuration={700}
                animationEasing="ease-out"
              />
              <Bar
                dataKey="referrals"
                fill="var(--color-referrals)"
                radius={[4, 4, 0, 0]}
                animationDuration={700}
                animationEasing="ease-out"
              />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>
    </div>
  );
}
