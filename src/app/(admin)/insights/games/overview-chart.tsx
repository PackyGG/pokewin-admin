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
import { formatCompactUsd, formatCurrency, formatDateTime } from "@/lib/utils/format";
import { format } from "date-fns";
import type { GamesOverviewTimePoint } from "@/lib/queries/insights-games/overview";

/**
 * Custom tooltip — hover any point on the chart to see the day's
 * P&L prominently with house-POV color. Wager + Payout shown below
 * for context.
 *
 * House-POV rule: positive PnL = house gained = emerald, negative =
 * house lost = rose. Matches the area-fill convention used by the
 * rest of the chart.
 */
function ChartTooltip({
  active,
  payload,
  label,
  bucketByHour,
}: {
  active?: boolean;
  payload?: Array<{ payload: GamesOverviewTimePoint }>;
  label?: string;
  bucketByHour: boolean;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  const pnlPositive = point.pnl >= 0;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {bucketByHour
          ? formatDateTime(new Date(label ?? point.bucket))
          : format(new Date(label ?? point.bucket), "EEE, MMM d, yyyy")}
      </div>
      <div className="mt-1.5 flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {pnlPositive ? "House profit" : "House loss"}
        </span>
        <span
          className={
            "text-lg font-bold tabular-nums " +
            (pnlPositive ? "text-emerald-500" : "text-rose-500")
          }
        >
          {pnlPositive ? "+" : ""}
          {formatCurrency(point.pnl)}
        </span>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        <span className="text-muted-foreground">Wager</span>
        <span className="text-right tabular-nums text-emerald-500">
          {formatCurrency(point.wager)}
        </span>
        <span className="text-muted-foreground">Payout</span>
        <span className="text-right tabular-nums text-rose-500">
          {formatCurrency(point.payout)}
        </span>
      </div>
    </div>
  );
}

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
            cursor={{ stroke: "currentColor", strokeOpacity: 0.2, strokeDasharray: "3 3" }}
            content={(props) => (
              <ChartTooltip
                {...(props as {
                  active?: boolean;
                  payload?: Array<{ payload: GamesOverviewTimePoint }>;
                  label?: string;
                })}
                bucketByHour={bucketByHour}
              />
            )}
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
