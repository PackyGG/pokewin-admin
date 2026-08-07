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
import { Card, CardContent } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
} from "@/components/ui/chart";
import { formatCompactUsd } from "@/lib/utils/format";

/**
 * Serializable slice of `DailyPnlPoint` the chart needs — the section passes
 * plain data across the RSC boundary, never the query result object.
 */
export type MoneyFlowPoint = {
  date: string;
  deposits: number;
  withdrawals: number;
  pnl: number;
};

// House-POV (CLAUDE.md): deposits are money the house gains → emerald;
// withdrawals are money leaving → rose. Same hexes the dashboard charts pin.
const DEPOSITS_COLOR = "#10b981"; // emerald-500
const WITHDRAWALS_COLOR = "#f43f5e"; // rose-500

const chartConfig = {
  deposits: { label: "Deposits", color: DEPOSITS_COLOR },
  withdrawals: { label: "Withdrawals", color: WITHDRAWALS_COLOR },
  pnl: { label: "House P&L", color: "var(--color-chart-1)" },
} satisfies ChartConfig;

type TooltipEntry = {
  dataKey?: string | number;
  value?: string | number;
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

function formatUsd(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function MoneyFlowTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
}) {
  if (!active || !payload?.length || !label) return null;

  const byKey = new Map(
    payload.map((entry) => [String(entry.dataKey), Number(entry.value ?? 0)]),
  );
  const deposits = byKey.get("deposits") ?? 0;
  const withdrawals = byKey.get("withdrawals") ?? 0;
  const pnl = byKey.get("pnl") ?? 0;

  const rows: { label: string; value: string; className: string }[] = [
    {
      label: "Deposits",
      value: formatUsd(deposits),
      className: "text-emerald-500",
    },
    {
      label: "Withdrawals",
      value: formatUsd(withdrawals),
      className: "text-rose-500",
    },
    {
      label: "Net cash",
      value: `${deposits - withdrawals >= 0 ? "+" : ""}${formatUsd(deposits - withdrawals)}`,
      className:
        deposits - withdrawals >= 0 ? "text-emerald-500" : "text-rose-500",
    },
    {
      label: "House P&L",
      value: `${pnl >= 0 ? "+" : ""}${formatUsd(pnl)}`,
      className: pnl >= 0 ? "text-emerald-500" : "text-rose-500",
    },
  ];

  return (
    <div className="min-w-52 rounded-lg border bg-popover p-3 text-xs shadow-md">
      <p className="mb-2 font-medium text-foreground">
        {longDateFormatter.format(new Date(`${label}T00:00:00Z`))}
      </p>
      <div className="space-y-1.5">
        {rows.map((row) => (
          <div
            key={row.label}
            className="flex items-center justify-between gap-6"
          >
            <span className="text-muted-foreground">{row.label}</span>
            <span
              className={`font-mono font-medium tabular-nums ${row.className}`}
            >
              {row.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Daily money flow: deposits vs withdrawals as grouped bars, house P&L as a
 * line over them. The P&L line reuses the exact `getDailyPnl` figures the
 * dashboard's Cash & P&L chart reconciles against — same formula, same scope.
 */
export function MoneyFlowChart({ data }: { data: MoneyFlowPoint[] }) {
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
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={64}
              tickFormatter={formatCompactUsd}
            />
            <ChartTooltip
              cursor={{ stroke: "var(--border)", strokeDasharray: "4 4" }}
              content={<MoneyFlowTooltip />}
            />
            <ReferenceLine y={0} stroke="var(--border)" />
            <Bar
              dataKey="deposits"
              fill={DEPOSITS_COLOR}
              fillOpacity={0.75}
              radius={[3, 3, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="withdrawals"
              fill={WITHDRAWALS_COLOR}
              fillOpacity={0.75}
              radius={[3, 3, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Line
              type="monotone"
              dataKey="pnl"
              stroke="var(--color-pnl)"
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
              ["deposits", "Deposits"],
              ["withdrawals", "Withdrawals"],
              ["pnl", "House P&L"],
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
