"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Gem } from "lucide-react";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { EmptyState } from "@/components/empty-state";
import { formatNumber } from "@/lib/utils/format";

// Shards are a NEUTRAL secondary wager currency (NOT USD), so the shard-spent
// trend is rendered neutral (cyan) — never a House-POV money colour and never
// a "$" axis. "Spent" here is the only real shard flow: shards burned opening
// shard packs (the sole shard sink).
const CYAN = "#06b6d4";

const spentConfig = {
  spent: { label: "Shards spent", color: CYAN },
} satisfies ChartConfig;

type DailyPoint = { date: string; spent: number; opens: number };

/** Round-then-format a shard count for axis/tooltip (no "$", shards only). */
function fmtShards(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded)
    ? formatNumber(rounded)
    : rounded.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
}

/**
 * The shard-flow trend chart — SHARDS SPENT on shard-pack opens over time
 * (the only real shard time-series: shards have no mint/earn ledger, and
 * opening shard packs is their sole sink). Receives ONLY the serializable
 * daily series (no function props across the RSC boundary). Everything is in
 * SHARDS, never USD. Renders gracefully with a single data point (the shard
 * packs are brand-new); shows an empty-state only when there is no daily data
 * at all.
 */
export function ShardEconomyCharts({ daily }: { daily: DailyPoint[] }) {
  if (daily.length === 0) {
    return (
      <EmptyState
        icon={Gem}
        title="No shard-pack opens yet"
        description="No shards have been spent opening shard packs in this window. The trend fills in as opens accrue."
        compact
      />
    );
  }

  return (
    <div className="rounded-2xl border bg-card/40 p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">Shards spent on opens</span>
        <span className="text-[11px] text-muted-foreground">
          shards burned opening shard packs · per day
        </span>
      </div>
      <ChartContainer
        config={spentConfig}
        className="aspect-auto h-[220px] w-full md:h-[260px]"
      >
        <AreaChart
          data={daily}
          margin={{ left: 6, right: 6 }}
          accessibilityLayer
        >
          <defs>
            <linearGradient id="shardSpentGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CYAN} stopOpacity={0.35} />
              <stop offset="100%" stopColor={CYAN} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            tickFormatter={(v: string) => v.slice(5)}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            width={56}
            allowDecimals={false}
            tickFormatter={(v: number) => fmtShards(Number(v))}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                formatter={(value) => `${fmtShards(Number(value))} shards`}
                hideIndicator
              />
            }
          />
          <Area
            type="monotone"
            dataKey="spent"
            stroke={CYAN}
            fill="url(#shardSpentGradient)"
            strokeWidth={2}
            animationDuration={700}
            animationEasing="ease-out"
          />
        </AreaChart>
      </ChartContainer>
    </div>
  );
}
