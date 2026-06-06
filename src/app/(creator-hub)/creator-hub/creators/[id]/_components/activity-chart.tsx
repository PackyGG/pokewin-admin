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
  Legend,
} from "recharts";
import { Activity } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Overview activity chart — multi-series over time (sign-ups + FTDs + wager +
 * deposits), per the owner spec.
 *
 * HONEST DATA STATE (this wave): there is NO existing per-bucket time-series
 * query for a SINGLE creator's affiliate cohort — the creator data layer
 * exposes lifetime totals + a 3-day momentum figure, not a bucketed series.
 * So this chart does NOT fabricate a line: when `series` is empty it renders
 * an empty recharts-style grid + an explicit "time-series not wired yet"
 * note, while the REAL totals we DO have are shown as the four headline
 * chips above the grid. Once a bucketed per-creator query lands, pass
 * `series` and the multi-series area renders for real.
 *
 * House-POV series colors: wager + deposits = money INTO the house →
 * emerald; sign-ups + FTDs = neutral funnel counts → blue / cyan. Client
 * component (recharts needs the browser); props are serializable.
 */

export type ActivityPoint = {
  label: string;
  signups: number;
  ftds: number;
  wagerUsd: number;
  depositsUsd: number;
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
  placeholderNote,
}: {
  headlineChips: HeadlineChip[];
  /** Bucketed multi-series; empty → placeholder grid (no fabricated line). */
  series?: ActivityPoint[];
  placeholderNote?: string;
}) {
  const hasSeries = series.length > 0;
  const signupsGrad = React.useId();
  const depositsGrad = React.useId();

  return (
    <div className="rounded-2xl border bg-card p-4 sm:p-5">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Activity className="size-4 text-emerald-500" />
          Activity
        </span>
      </div>

      {/* REAL headline totals (sign-ups / FTDs / wager / deposits) — the
          figures that DO exist today, house-POV colored. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
        {hasSeries ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={series}
              margin={{ top: 6, right: 4, left: 4, bottom: 0 }}
            >
              <defs>
                <linearGradient id={signupsGrad} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#60a5fa" stopOpacity={0} />
                </linearGradient>
                <linearGradient id={depositsGrad} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#34d399" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
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
                width={40}
              />
              <Tooltip
                contentStyle={{
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  background: "var(--card)",
                  fontSize: 12,
                }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area
                type="monotone"
                dataKey="depositsUsd"
                name="Deposits"
                stroke="#34d399"
                strokeWidth={2}
                fill={`url(#${depositsGrad})`}
                animationDuration={700}
                animationEasing="ease-out"
              />
              <Area
                type="monotone"
                dataKey="signups"
                name="Sign-ups"
                stroke="#60a5fa"
                strokeWidth={2}
                fill={`url(#${signupsGrad})`}
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
              {placeholderNote ??
                "Per-creator time-series not wired yet — totals above are live."}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
