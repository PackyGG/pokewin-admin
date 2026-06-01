"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatCompactUsd, formatDateTime } from "@/lib/utils/format";
import { format } from "date-fns";
import type { GamesOverviewTimePoint } from "@/lib/queries/insights-games/overview";

/**
 * Time-series area chart for the Overview tab. Three series stacked
 * visually: wager (emerald — house gained from staking), payout
 * (rose — house paid out), and the line of P&L (the difference).
 *
 * House-POV coloring: the wager-side area is emerald (the house
 * collecting money), the payout area is rose (money flowing back
 * to users). Net pnl line is emerald above 0, rose below.
 *
 * Bucket key: ISO date / hour string. We format with date-fns so
 * the X axis reads in the operator's locale.
 */
export function OverviewChart({
  data,
  bucketByHour,
}: {
  data: GamesOverviewTimePoint[];
  bucketByHour: boolean;
}) {
  // Empty-state guard — Recharts is happy to render an axis with
  // no points but the operator gets nothing to look at, so we
  // surface a tasteful empty state instead.
  if (data.length === 0) {
    return (
      <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">
        No game activity in this period.
      </div>
    );
  }

  return (
    <div className="h-72 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={data}
          margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
        >
          <defs>
            <linearGradient id="games-wager" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="rgb(16 185 129)" stopOpacity={0.45} />
              <stop offset="95%" stopColor="rgb(16 185 129)" stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="games-payout" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="rgb(244 63 94)" stopOpacity={0.45} />
              <stop offset="95%" stopColor="rgb(244 63 94)" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.1} />
          <XAxis
            dataKey="bucket"
            tick={{ fill: "currentColor", opacity: 0.6, fontSize: 11 }}
            tickFormatter={(v) =>
              format(new Date(v), bucketByHour ? "HH:mm" : "MMM d")
            }
          />
          <YAxis
            tick={{ fill: "currentColor", opacity: 0.6, fontSize: 11 }}
            tickFormatter={(v) => formatCompactUsd(Number(v))}
            width={56}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "hsl(var(--popover))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              fontSize: 12,
            }}
            labelFormatter={(v) =>
              formatDateTime(new Date(v as string))
            }
            formatter={(value, name) => [
              formatCompactUsd(Number(value)),
              name === "wager"
                ? "Wager"
                : name === "payout"
                  ? "Payout"
                  : "PnL",
            ]}
          />
          <Area
            type="monotone"
            dataKey="wager"
            stroke="rgb(16 185 129)"
            strokeWidth={2}
            fill="url(#games-wager)"
            animationDuration={700}
            animationEasing="ease-out"
          />
          <Area
            type="monotone"
            dataKey="payout"
            stroke="rgb(244 63 94)"
            strokeWidth={2}
            fill="url(#games-payout)"
            animationDuration={700}
            animationEasing="ease-out"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
