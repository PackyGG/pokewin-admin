"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { formatCurrency } from "@/lib/utils/format";

/**
 * Forecast comparison chart — generated value vs deal spend per span (1w / 2w /
 * 1m), grouped bars.
 *
 * House-POV colors (the ONE rule): generated value = money the deal makes the
 * HOUSE → emerald; deal spend = what the deal COSTS the house → rose. When a
 * bar sits above its spend pair the span is profitable; the per-span verdict
 * cards above carry the explicit y/n + rate of return.
 *
 * Client component (recharts needs the browser). Props are fully serializable
 * (plain numbers/strings) — NO function props cross the server→client boundary.
 * Empty/zero data → an explicit placeholder grid rather than a fabricated bar.
 */

export type ForecastChartPoint = {
  label: string;
  generatedValueUsd: number;
  dealSpendUsd: number;
};

export function ForecastChart({
  data,
  hasData,
}: {
  data: ForecastChartPoint[];
  hasData: boolean;
}) {
  if (!hasData) {
    return (
      <div className="relative h-[240px] w-full">
        <div
          aria-hidden
          className="h-full w-full rounded-md border border-dashed border-border/60 bg-[linear-gradient(to_bottom,transparent_calc(50%-0.5px),var(--border)_50%,transparent_calc(50%+0.5px)),linear-gradient(to_bottom,transparent_calc(25%-0.5px),color-mix(in_oklab,var(--border)_50%,transparent)_25%,transparent_calc(25%+0.5px)),linear-gradient(to_bottom,transparent_calc(75%-0.5px),color-mix(in_oklab,var(--border)_50%,transparent)_75%,transparent_calc(75%+0.5px))]"
        />
        <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
          Not enough data to chart yet — needs a current wager rate and a deal
          spend envelope.
        </p>
      </div>
    );
  }

  return (
    <div className="h-[240px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 4, left: 4, bottom: 0 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="currentColor"
            className="text-border/50"
            vertical={false}
          />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11 }}
            stroke="currentColor"
            className="text-muted-foreground"
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10 }}
            stroke="currentColor"
            className="text-muted-foreground"
            width={52}
            tickFormatter={(v: number) => formatCurrency(v)}
          />
          <Tooltip
            cursor={{ fill: "var(--muted)", opacity: 0.3 }}
            contentStyle={{
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--card)",
              fontSize: 12,
            }}
            formatter={(value: number, name: string) => [
              formatCurrency(value),
              name,
            ]}
          />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Bar
            dataKey="generatedValueUsd"
            name="Generated value"
            fill="#34d399"
            radius={[4, 4, 0, 0]}
            animationDuration={700}
            animationEasing="ease-out"
          />
          <Bar
            dataKey="dealSpendUsd"
            name="Deal spend"
            fill="#fb7185"
            radius={[4, 4, 0, 0]}
            animationDuration={700}
            animationEasing="ease-out"
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
