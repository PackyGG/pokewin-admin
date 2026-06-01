"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { EmptyState } from "@/components/empty-state";
import { Scale } from "lucide-react";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";

// House-POV: a CREDIT to a user is a payout the house gives → rose. A
// DEBIT (house takes balance back, incl. manual withdrawals) → emerald.
const ROSE = "#f43f5e";
const EMERALD = "#10b981";

const chartConfig = {
  creditVolume: { label: "Credits (house pays)", color: ROSE },
  debitVolume: { label: "Debits (house takes)", color: EMERALD },
} satisfies ChartConfig;

/**
 * Daily balance-adjustment volume — two stacked-area series split by
 * direction. Rose = credit volume (house gave users money), emerald =
 * debit volume (house took balance back). Same recharts + ChartContainer
 * setup as the deposit-bonus chart so styling stays consistent.
 */
export function BalanceAdjustmentDailyChart({
  daily,
}: {
  daily: Array<{ date: string; creditVolume: number; debitVolume: number }>;
}) {
  if (daily.length === 0) {
    return (
      <EmptyState
        icon={Scale}
        title="No adjustments in this window"
        description="No admin balance adjustments were made in the selected period. Try a longer period."
        compact
      />
    );
  }

  return (
    <ChartContainer
      config={chartConfig}
      className="aspect-auto h-[260px] w-full md:h-[320px]"
    >
      <AreaChart data={daily} margin={{ left: 6, right: 6 }} accessibilityLayer>
        <defs>
          <linearGradient id="adjCreditGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={ROSE} stopOpacity={0.35} />
            <stop offset="100%" stopColor={ROSE} stopOpacity={0.02} />
          </linearGradient>
          <linearGradient id="adjDebitGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={EMERALD} stopOpacity={0.35} />
            <stop offset="100%" stopColor={EMERALD} stopOpacity={0.02} />
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
          width={70}
          tickFormatter={formatCompactUsd}
        />
        <ChartTooltip
          content={
            <ChartTooltipContent
              formatter={(value) => formatCurrency(Number(value))}
            />
          }
        />
        <Area
          type="monotone"
          dataKey="creditVolume"
          stroke={ROSE}
          fill="url(#adjCreditGradient)"
          strokeWidth={2}
          stackId="vol"
          animationDuration={700}
          animationEasing="ease-out"
        />
        <Area
          type="monotone"
          dataKey="debitVolume"
          stroke={EMERALD}
          fill="url(#adjDebitGradient)"
          strokeWidth={2}
          stackId="vol"
          animationDuration={700}
          animationEasing="ease-out"
        />
      </AreaChart>
    </ChartContainer>
  );
}
