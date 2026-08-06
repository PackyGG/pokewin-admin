"use client";

import * as React from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import { Activity, ChartNoAxesCombined } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { AntifraudOverviewDay } from "@/lib/antifraud/overview";
import { formatCurrency } from "@/lib/utils/format";

/**
 * The two 30-day charts, deliberately split out of `overview-panels.tsx`.
 *
 * Recharts is the heaviest client dependency in the antifraud sub-app and this
 * is its only importer. While the charts shared a module with
 * `OverviewActionFeed`, the feed could not hydrate — and therefore could not
 * open its SSE stream — until the whole Recharts chunk had downloaded and
 * executed. Keep them in separate modules.
 */

const compactCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  notation: "compact",
  maximumFractionDigits: 1,
});

const fiatConfig = {
  legitimateFiatCents: {
    label: "Legitimate",
    color: "var(--color-emerald-500)",
  },
  fraudulentFiatCents: {
    label: "Fraud",
    color: "var(--color-rose-500)",
  },
} satisfies ChartConfig;

const accountConfig = {
  signups: { label: "Signups", color: "var(--color-blue-500)" },
  bans: { label: "Banned", color: "var(--color-rose-500)" },
  locks: { label: "Locked", color: "var(--color-amber-500)" },
  caught: { label: "Caught", color: "var(--color-purple-500)" },
} satisfies ChartConfig;

function dateLabel(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function OverviewCharts({ days }: { days: AntifraudOverviewDay[] }) {
  const reducedMotion = useReducedMotion();
  const accountDays = days.filter((day) => day.date !== "2026-07-22");

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="space-y-3 rounded-xl border border-border/60 bg-card p-3 sm:p-4">
        <SectionHeading
          icon={ChartNoAxesCombined}
          title={
            <span>
              Fiat deposits
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                30 days
              </span>
            </span>
          }
        />
        {/* Fixed height + aspect-auto: ChartContainer's default `aspect-video`
            inside a flex-grow/h-full chain lets ResponsiveContainer re-measure
            its own growth (the "20x giant panel" bug). A hard height breaks
            the feedback loop for good. */}
        <ChartContainer
          config={fiatConfig}
          className="aspect-auto h-[260px] w-full"
        >
          <AreaChart
            data={days}
            accessibilityLayer
            margin={{ top: 8, right: 8, left: -8, bottom: 0 }}
          >
            <defs>
              <linearGradient id="legit-fiat-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-legitimateFiatCents)" stopOpacity={0.35} />
                <stop offset="95%" stopColor="var(--color-legitimateFiatCents)" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="fraud-fiat-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-fraudulentFiatCents)" stopOpacity={0.32} />
                <stop offset="95%" stopColor="var(--color-fraudulentFiatCents)" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={dateLabel}
              tickLine={false}
              axisLine={false}
              minTickGap={24}
            />
            <YAxis
              tickFormatter={(value: number) =>
                compactCurrency.format(value / 100)
              }
              tickLine={false}
              axisLine={false}
              width={56}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => dateLabel(String(value))}
                  formatter={(value, name) => (
                    <span className="flex min-w-32 items-center justify-between gap-3">
                      <span>{fiatConfig[name as keyof typeof fiatConfig]?.label}</span>
                      <span className="font-mono font-medium tabular-nums">
                        {formatCurrency(Number(value) / 100)}
                      </span>
                    </span>
                  )}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            <Area
              type="monotone"
              dataKey="legitimateFiatCents"
              stroke="var(--color-legitimateFiatCents)"
              fill="url(#legit-fiat-fill)"
              strokeWidth={2}
              isAnimationActive={!reducedMotion}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Area
              type="monotone"
              dataKey="fraudulentFiatCents"
              stroke="var(--color-fraudulentFiatCents)"
              fill="url(#fraud-fiat-fill)"
              strokeWidth={2}
              isAnimationActive={!reducedMotion}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </AreaChart>
        </ChartContainer>
      </section>

      <section className="space-y-3 rounded-xl border border-border/60 bg-card p-3 sm:p-4">
        <SectionHeading
          icon={Activity}
          title={
            <span>
              Accounts
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                30 days
              </span>
            </span>
          }
        />
        <ChartContainer
          config={accountConfig}
          className="aspect-auto h-[260px] w-full"
        >
          <LineChart
            data={accountDays}
            accessibilityLayer
            margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
          >
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={dateLabel}
              tickLine={false}
              axisLine={false}
              minTickGap={24}
            />
            <YAxis
              allowDecimals={false}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent
                  labelFormatter={(value) => dateLabel(String(value))}
                />
              }
            />
            <ChartLegend content={<ChartLegendContent />} />
            {(["signups", "bans", "locks", "caught"] as const).map((key) => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                stroke={`var(--color-${key})`}
                strokeWidth={2}
                dot={false}
                isAnimationActive={!reducedMotion}
                animationDuration={700}
                animationEasing="ease-out"
              />
            ))}
          </LineChart>
        </ChartContainer>
      </section>
    </div>
  );
}
