"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatCompactUsd } from "@/lib/utils/format";

type DailyPoint = {
  date: string;
  deposits: number;
  withdrawals: number;
  wager: number;
  wagerOrganic: number;
  wagerCreatorCoded: number;
  ggr: number;
  ngr: number;
  signups: number;
  active: number;
};

const moneyConfig = {
  deposits: { label: "Deposits", color: "rgb(16 185 129)" },
  withdrawals: { label: "Withdrawals", color: "rgb(244 63 94)" },
  wager: { label: "Wager", color: "rgb(59 130 246)" },
  ggr: { label: "GGR", color: "rgb(16 185 129)" },
  ngr: { label: "NGR", color: "rgb(20 184 166)" },
} satisfies ChartConfig;

// Wager attribution — both legs are customer wager (house-positive on
// entry per CLAUDE.md, so emerald-family, NOT rose). Organic uses the
// solid emerald; creator-coded uses amber so the split reads at a glance
// without implying a user win.
const attributionConfig = {
  wagerOrganic: { label: "Organic", color: "rgb(16 185 129)" },
  wagerCreatorCoded: { label: "Creator-coded", color: "rgb(245 158 11)" },
} satisfies ChartConfig;

const usersConfig = {
  signups: { label: "Signups", color: "rgb(59 130 246)" },
  active: { label: "Active", color: "rgb(6 182 212)" },
} satisfies ChartConfig;

/**
 * Three small charts side-by-side for the Overview tab:
 *   • money flow: deposits + withdrawals stacked-ish (lines)
 *   • revenue: GGR + NGR
 *   • users: signups + active
 *
 * House-POV colors throughout. Animation tokens match the rest of the
 * admin (700ms, ease-out).
 */
export function OverviewChart({ data }: { data: DailyPoint[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium">Money flow</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Deposits (emerald) vs withdrawals (rose)
          </p>
        </CardHeader>
        <CardContent>
          <ChartContainer
            config={moneyConfig}
            className="h-[200px] w-full"
          >
            <BarChart data={data} accessibilityLayer>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={6}
                tickFormatter={(v) => v.slice(5)}
                fontSize={10}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={6}
                width={56}
                tickFormatter={formatCompactUsd}
                fontSize={10}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) => `$${Number(value).toFixed(2)}`}
                  />
                }
              />
              <Bar
                dataKey="deposits"
                fill="rgb(16 185 129)"
                animationDuration={700}
                animationEasing="ease-out"
                radius={[3, 3, 0, 0]}
              />
              <Bar
                dataKey="withdrawals"
                fill="rgb(244 63 94)"
                animationDuration={700}
                animationEasing="ease-out"
                radius={[3, 3, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium">Revenue</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            GGR (gaming-only) + NGR (after reward cost). Canonical
            inventory-delta model.
          </p>
        </CardHeader>
        <CardContent>
          <ChartContainer config={moneyConfig} className="h-[200px] w-full">
            <LineChart data={data} accessibilityLayer>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={6}
                tickFormatter={(v) => v.slice(5)}
                fontSize={10}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={6}
                width={56}
                tickFormatter={formatCompactUsd}
                fontSize={10}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) => `$${Number(value).toFixed(2)}`}
                  />
                }
              />
              <Line
                type="monotone"
                dataKey="ggr"
                stroke="rgb(16 185 129)"
                strokeWidth={2}
                dot={false}
                animationDuration={700}
                animationEasing="ease-out"
              />
              <Line
                type="monotone"
                dataKey="ngr"
                stroke="rgb(20 184 166)"
                strokeWidth={2}
                dot={false}
                animationDuration={700}
                animationEasing="ease-out"
              />
            </LineChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium">Users</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Signups (blue) + active (cyan)
          </p>
        </CardHeader>
        <CardContent>
          <ChartContainer config={usersConfig} className="h-[200px] w-full">
            <LineChart data={data} accessibilityLayer>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={6}
                tickFormatter={(v) => v.slice(5)}
                fontSize={10}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={6}
                width={40}
                fontSize={10}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Line
                type="monotone"
                dataKey="signups"
                stroke="rgb(59 130 246)"
                strokeWidth={2}
                dot={false}
                animationDuration={700}
                animationEasing="ease-out"
              />
              <Line
                type="monotone"
                dataKey="active"
                stroke="rgb(6 182 212)"
                strokeWidth={2}
                dot={false}
                animationDuration={700}
                animationEasing="ease-out"
              />
            </LineChart>
          </ChartContainer>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium">
            Wager attribution
          </CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Organic (emerald) vs creator-coded (amber) — customer wager by
            signup source
          </p>
        </CardHeader>
        <CardContent>
          <ChartContainer
            config={attributionConfig}
            className="h-[200px] w-full"
          >
            <BarChart data={data} accessibilityLayer>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={6}
                tickFormatter={(v) => v.slice(5)}
                fontSize={10}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={6}
                width={56}
                tickFormatter={formatCompactUsd}
                fontSize={10}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) => `$${Number(value).toFixed(2)}`}
                  />
                }
              />
              {/* Stacked so the bar height reads as total customer wager,
                  split by signup source. */}
              <Bar
                dataKey="wagerOrganic"
                stackId="wager"
                fill="rgb(16 185 129)"
                animationDuration={700}
                animationEasing="ease-out"
                radius={[0, 0, 0, 0]}
              />
              <Bar
                dataKey="wagerCreatorCoded"
                stackId="wager"
                fill="rgb(245 158 11)"
                animationDuration={700}
                animationEasing="ease-out"
                radius={[3, 3, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        </CardContent>
      </Card>
    </div>
  );
}

