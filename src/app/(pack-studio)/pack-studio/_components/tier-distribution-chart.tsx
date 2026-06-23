"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";

import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";

/**
 * Tier-distribution histogram (T1..T5 → pack count) for the Pack-Studio
 * overview. A "use client" island because recharts needs the browser; the
 * server passes a plain serializable array (no function props over the RSC
 * boundary). Bars animate in over 700ms ease-out and snap (no animation)
 * under `prefers-reduced-motion`, matching the house chart convention.
 *
 * Color is neutral (chart-1 / primary tint) — a volatility tier is not a
 * money figure, so House-POV finance colors deliberately do NOT apply here.
 */

export type TierDatum = { tier: string; count: number };

const config = {
  count: { label: "Packs", color: "var(--color-chart-1)" },
} satisfies ChartConfig;

export function TierDistributionChart({ data }: { data: TierDatum[] }) {
  // Respect reduced motion: disable the bar grow-in when the user asks for it.
  const prefersReducedMotion =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  return (
    <ChartContainer config={config} className="h-[220px] w-full">
      <BarChart
        data={data}
        accessibilityLayer
        margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
      >
        <CartesianGrid vertical={false} />
        <XAxis dataKey="tier" tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          width={40}
          allowDecimals={false}
        />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar
          dataKey="count"
          fill="var(--color-count)"
          radius={[6, 6, 0, 0]}
          isAnimationActive={!prefersReducedMotion}
          animationDuration={700}
          animationEasing="ease-out"
        />
      </BarChart>
    </ChartContainer>
  );
}
