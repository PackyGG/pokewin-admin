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

// House-POV on the two shard legs (shards are a secondary currency, NOT USD —
// never rendered with "$"):
//   • EARNED — shards a game paid back to users = a house liability/out → rose
//   • SPENT  — shards wagered into games = the house takes them in → emerald
const ROSE = "#f43f5e";
const EMERALD = "#10b981";

const earnedConfig = {
  earned: { label: "Shards earned", color: ROSE },
} satisfies ChartConfig;

const spentConfig = {
  spent: { label: "Shards spent", color: EMERALD },
} satisfies ChartConfig;

type DailyPoint = { date: string; earned: number; spent: number };

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
 * The two shard ECONOMY trend charts — earnings (rose) and spendings
 * (emerald) over time — rendered side by side on lg+, stacked on mobile.
 * Receives ONLY the serializable daily series (no function props across the
 * RSC boundary). Everything is in SHARDS, never USD. Renders gracefully with a
 * single data point (the shard ledger is brand-new); shows an empty-state only
 * when there is no daily data at all.
 */
export function ShardEconomyCharts({ daily }: { daily: DailyPoint[] }) {
  if (daily.length === 0) {
    return (
      <EmptyState
        icon={Gem}
        title="No shard activity yet"
        description="No shard earnings or spendings have been recorded in this window. The trend fills in as activity accrues."
        compact
      />
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <SingleSeriesChart
        title="Shard earnings"
        hint="shards paid out to users · house out"
        data={daily}
        dataKey="earned"
        color={ROSE}
        gradientId="shardEarnedGradient"
        config={earnedConfig}
      />
      <SingleSeriesChart
        title="Shard spendings"
        hint="shards wagered into games · house in"
        data={daily}
        dataKey="spent"
        color={EMERALD}
        gradientId="shardSpentGradient"
        config={spentConfig}
      />
    </div>
  );
}

function SingleSeriesChart({
  title,
  hint,
  data,
  dataKey,
  color,
  gradientId,
  config,
}: {
  title: string;
  hint: string;
  data: DailyPoint[];
  dataKey: "earned" | "spent";
  color: string;
  gradientId: string;
  config: ChartConfig;
}) {
  return (
    <div className="rounded-2xl border bg-card/40 p-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-[11px] text-muted-foreground">{hint}</span>
      </div>
      <ChartContainer
        config={config}
        className="aspect-auto h-[220px] w-full md:h-[260px]"
      >
        <AreaChart data={data} margin={{ left: 6, right: 6 }} accessibilityLayer>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
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
            dataKey={dataKey}
            stroke={color}
            fill={`url(#${gradientId})`}
            strokeWidth={2}
            animationDuration={700}
            animationEasing="ease-out"
          />
        </AreaChart>
      </ChartContainer>
    </div>
  );
}
