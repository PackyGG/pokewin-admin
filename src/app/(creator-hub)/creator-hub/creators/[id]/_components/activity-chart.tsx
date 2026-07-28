"use client";

import * as React from "react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  CartesianGrid,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Activity } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";

/**
 * Overview activity chart — bucketed wager / deposits / GGR for the creator's
 * attributed cohort over the selected window.
 *
 * Series colors come from the THEME chart tokens (`--chart-*`) so the three
 * lines are visually distinguishable in every theme (the old hardcoded
 * near-identical green hexes were not). The headline chips above keep the
 * house-POV money colors and double as the legend (no recharts `<Legend>`).
 *
 * Client component (recharts needs the browser); props are serializable.
 */

const SERIES_COLORS = {
  wager: "var(--chart-2)",
  deposits: "var(--chart-3)",
  ggr: "var(--chart-1)",
} as const;

export type ActivityPoint = {
  label: string;
  wagerUsd: number;
  depositsUsd: number;
  ggrUsd: number;
};

type HeadlineChip = {
  label: string;
  value: string;
  /** Tailwind text color class (house-POV chosen by the caller). */
  colorClass: string;
};

export function ActivityChart({
  headlineChips,
  series = [],
  periodControl,
  emptyNote,
}: {
  headlineChips: HeadlineChip[];
  /** Bucketed multi-series for the active window. */
  series?: ActivityPoint[];
  /** Server-rendered period chips (URL-driven). */
  periodControl?: React.ReactNode;
  emptyNote?: string;
}) {
  const hasData = series.some(
    (p) => p.wagerUsd > 0 || p.depositsUsd > 0 || p.ggrUsd !== 0,
  );
  const wagerGrad = React.useId();
  const depositsGrad = React.useId();
  const ggrGrad = React.useId();

  return (
    <Card size="sm" className="block gap-0 p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="size-4 text-emerald-500" />
          Activity
        </span>
        {periodControl}
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {headlineChips.map((chip) => (
          <div
            key={chip.label}
            className="rounded-lg border bg-background/40 px-3 py-2"
          >
            <div className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {chip.label}
            </div>
            <div
              className={cn(
                "mt-0.5 truncate text-lg font-bold tabular-nums",
                chip.colorClass,
              )}
            >
              {chip.value}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 h-[200px] w-full">
        {hasData ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={series}
              margin={{ top: 6, right: 4, left: 4, bottom: 0 }}
            >
              <defs>
                <linearGradient id={wagerGrad} x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor={SERIES_COLORS.wager}
                    stopOpacity={0.28}
                  />
                  <stop
                    offset="100%"
                    stopColor={SERIES_COLORS.wager}
                    stopOpacity={0}
                  />
                </linearGradient>
                <linearGradient id={depositsGrad} x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor={SERIES_COLORS.deposits}
                    stopOpacity={0.24}
                  />
                  <stop
                    offset="100%"
                    stopColor={SERIES_COLORS.deposits}
                    stopOpacity={0}
                  />
                </linearGradient>
                <linearGradient id={ggrGrad} x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor={SERIES_COLORS.ggr}
                    stopOpacity={0.22}
                  />
                  <stop
                    offset="100%"
                    stopColor={SERIES_COLORS.ggr}
                    stopOpacity={0}
                  />
                </linearGradient>
              </defs>
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
                tick={{ fontSize: 10 }}
                stroke="currentColor"
                className="text-muted-foreground"
                minTickGap={24}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 10 }}
                stroke="currentColor"
                className="text-muted-foreground"
                width={48}
                tickFormatter={(v: number) => formatCompactUsd(v)}
              />
              <Tooltip
                contentStyle={{
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--card)",
                  fontSize: 12,
                }}
                formatter={(value: number, name: string) => [
                  formatCurrency(value),
                  String(name),
                ]}
              />
              <Area
                type="monotone"
                dataKey="wagerUsd"
                name="Wager"
                stroke={SERIES_COLORS.wager}
                strokeWidth={2}
                fill={`url(#${wagerGrad})`}
                animationDuration={700}
                animationEasing="ease-out"
              />
              <Area
                type="monotone"
                dataKey="depositsUsd"
                name="Deposits"
                stroke={SERIES_COLORS.deposits}
                strokeWidth={2}
                fill={`url(#${depositsGrad})`}
                animationDuration={700}
                animationEasing="ease-out"
              />
              <Area
                type="monotone"
                dataKey="ggrUsd"
                name="GGR"
                stroke={SERIES_COLORS.ggr}
                strokeWidth={2}
                fill={`url(#${ggrGrad})`}
                animationDuration={700}
                animationEasing="ease-out"
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="relative flex h-full w-full flex-col">
            <div
              aria-hidden
              className="flex-1 rounded-md border border-dashed border-border/60 bg-[linear-gradient(to_bottom,transparent_calc(50%-0.5px),var(--border)_50%,transparent_calc(50%+0.5px)),linear-gradient(to_bottom,transparent_calc(25%-0.5px),color-mix(in_oklab,var(--border)_50%,transparent)_25%,transparent_calc(25%+0.5px)),linear-gradient(to_bottom,transparent_calc(75%-0.5px),color-mix(in_oklab,var(--border)_50%,transparent)_75%,transparent_calc(75%+0.5px))]"
            />
            <p className="pointer-events-none absolute inset-0 flex items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
              {emptyNote ??
                "No attributed wager, deposit, or GGR activity in this window yet."}
            </p>
          </div>
        )}
      </div>
    </Card>
  );
}
