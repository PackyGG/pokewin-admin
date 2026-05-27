"use client";

import { Bar, BarChart, CartesianGrid, XAxis, YAxis, Cell } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";

const wagerConfig = {
  packs: {
    label: "Packs",
    color: "var(--color-chart-2)",
  },
  battles: {
    label: "Battles",
    color: "var(--color-chart-4)",
  },
  upgrader: {
    label: "Upgrader",
    color: "var(--color-chart-5)",
  },
} satisfies ChartConfig;

const depositsConfig = {
  amount: {
    label: "Deposits",
    color: "var(--color-chart-3)",
  },
} satisfies ChartConfig;

const signupsConfig = {
  count: {
    label: "Signups",
    color: "var(--color-chart-1)",
  },
} satisfies ChartConfig;

const ftdsConfig = {
  count: {
    label: "FTDs",
    color: "var(--color-chart-5)",
  },
} satisfies ChartConfig;

// Active Depositors uses a hex (cyan-500) rather than a chart-N var so
// it stays visually distinct from the Signups chart in the same row.
const activeDepositorsConfig = {
  count: {
    label: "Depositors",
    color: "#06b6d4",
  },
} satisfies ChartConfig;

// P&L bars are colored per-day by sign (House-POV): house up = emerald,
// house down = rose. Cell fills override the config, but ChartContainer
// still needs a config entry for the dataKey.
const pnlConfig = {
  pnl: { label: "P&L" },
} satisfies ChartConfig;

const PNL_UP = "#10b981"; // emerald-500 — house in profit that day
const PNL_DOWN = "#f43f5e"; // rose-500 — house down that day

/**
 * Custom tooltip for the stacked Wagers chart — renders Packs + Battles
 * with their colors, then a "Total" row showing both combined. The
 * default ChartTooltipContent only lists individual stack segments, so
 * an admin had to mentally add packs+battles to read the day's total.
 *
 * Styling mirrors ChartTooltipContent (see src/components/ui/chart.tsx)
 * so the two tooltips stay visually consistent across the dashboard.
 */
function WagerTooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{
    dataKey?: string | number;
    value?: number | string;
    color?: string;
  }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const labelByKey: Record<string, string> = {
    packs: "Packs",
    battles: "Battles",
    upgrader: "Upgrader",
  };
  const total = payload.reduce(
    (sum, item) => sum + Number(item?.value ?? 0),
    0,
  );
  return (
    <div className="grid min-w-32 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      {label && <div className="font-medium">{label}</div>}
      <div className="grid gap-1.5">
        {payload.map((item) => {
          const key = String(item.dataKey ?? "");
          return (
            <div key={key} className="flex items-center gap-2">
              <div
                className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ background: item.color }}
              />
              <div className="flex flex-1 items-center justify-between leading-none">
                <span className="text-muted-foreground">
                  {labelByKey[key] ?? key}
                </span>
                <span className="font-mono font-medium tabular-nums text-foreground">
                  {formatCurrency(Number(item.value ?? 0))}
                </span>
              </div>
            </div>
          );
        })}
        <div className="mt-0.5 flex items-center gap-2 border-t border-border/50 pt-1.5">
          {/* Spacer to align the Total label with the rows above. */}
          <div className="h-2.5 w-2.5 shrink-0" />
          <div className="flex flex-1 items-center justify-between leading-none">
            <span className="font-semibold">Total</span>
            <span className="font-mono font-semibold tabular-nums text-foreground">
              {formatCurrency(total)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function WagerChart({
  data,
}: {
  data: { date: string; packs: number; battles: number; upgrader: number }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Wagers (30 days)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={wagerConfig} className="h-[220px] w-full md:h-[260px] lg:h-[300px]">
          <BarChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => v.slice(5)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={70}
              tickFormatter={formatCompactUsd}
            />
            <ChartTooltip content={<WagerTooltipContent />} />
            {/* Stacked bars: Packs at the bottom, Battles in the
                middle, Upgrader on top. Only the top segment gets the
                rounded corner so the stack reads as one bar. */}
            <Bar
              dataKey="packs"
              stackId="wager"
              fill="var(--color-packs)"
              radius={[0, 0, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="battles"
              stackId="wager"
              fill="var(--color-battles)"
              radius={[0, 0, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="upgrader"
              stackId="wager"
              fill="var(--color-upgrader)"
              radius={[4, 4, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

export function DepositsChart({
  data,
}: {
  data: { date: string; amount: number }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Deposits (30 days)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={depositsConfig} className="h-[220px] w-full md:h-[260px] lg:h-[300px]">
          <BarChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => v.slice(5)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={70}
              tickFormatter={formatCompactUsd}
            />
            <ChartTooltip content={<DepositsTooltipContent />} />
            <Bar
              dataKey="amount"
              fill="var(--color-amount)"
              radius={[4, 4, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/**
 * Tooltip for the Deposits chart — same visual weight as the Wagers
 * tooltip (bold value, semibold figure, color chip), instead of the
 * default ChartTooltipContent which rendered the formatter string
 * unstyled and read as light grey text.
 */
function DepositsTooltipContent({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{
    dataKey?: string | number;
    value?: number | string;
    color?: string;
  }>;
  label?: string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const item = payload[0];
  const amount = Number(item?.value ?? 0);
  return (
    <div className="grid min-w-32 items-start gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      {label && <div className="font-medium">{label}</div>}
      <div className="flex items-center gap-2">
        <div
          className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
          style={{ background: item?.color }}
        />
        <div className="flex flex-1 items-center justify-between leading-none">
          <span className="text-muted-foreground">Deposits</span>
          <span className="font-mono font-semibold tabular-nums text-foreground">
            {formatCurrency(amount)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function SignupsChart({
  data,
}: {
  data: { date: string; count: number }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Signups (30 days)</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={signupsConfig} className="h-[220px] w-full md:h-[260px] lg:h-[300px]">
          <BarChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => v.slice(5)}
            />
            <YAxis tickLine={false} axisLine={false} tickMargin={8} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar
              dataKey="count"
              fill="var(--color-count)"
              radius={[4, 4, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

export function ActiveDepositorsChart({
  data,
}: {
  data: { date: string; count: number }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Active Depositors (30 days)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={activeDepositorsConfig} className="h-[220px] w-full md:h-[260px] lg:h-[300px]">
          <BarChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => v.slice(5)}
            />
            <YAxis tickLine={false} axisLine={false} tickMargin={8} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Bar
              dataKey="count"
              fill="var(--color-count)"
              radius={[4, 4, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/**
 * Custom hover for the FTDs chart — the bar shows the daily count, and the
 * tooltip adds the total first-deposit value and the average. Recharts
 * clones this element with `active`/`payload`, so we read the day's row off
 * payload[0].payload. Styling mirrors ChartTooltipContent's container.
 */
function FtdsTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: { count: number; total: number; avg: number } }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="grid min-w-32 gap-0.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <span className="font-medium text-foreground">
        {p.count} {p.count === 1 ? "FTD" : "FTDs"}
      </span>
      <span className="text-muted-foreground">
        Total {formatCurrency(p.total)}
      </span>
      <span className="text-muted-foreground">Avg {formatCurrency(p.avg)}</span>
    </div>
  );
}

export function FtdsChart({
  data,
}: {
  data: { date: string; count: number; total: number; avg: number }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">FTDs (30 days)</CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={ftdsConfig} className="h-[220px] w-full md:h-[260px] lg:h-[300px]">
          <BarChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => v.slice(5)}
            />
            <YAxis tickLine={false} axisLine={false} tickMargin={8} />
            <ChartTooltip content={<FtdsTooltip />} />
            <Bar
              dataKey="count"
              fill="var(--color-count)"
              radius={[4, 4, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            />
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}

/**
 * Hover for the daily P&L chart — the day's P&L (colored House-POV) plus
 * the gross deposits/withdrawals that drove it.
 */
function PnlTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{
    payload: {
      date: string;
      pnl: number;
      deposits: number;
      withdrawals: number;
    };
  }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  const up = p.pnl >= 0;
  return (
    <div className="grid min-w-40 gap-0.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <span className="font-medium text-foreground">{p.date}</span>
      <span
        className={
          "font-semibold " +
          (up
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-rose-600 dark:text-rose-400")
        }
      >
        P&amp;L {up ? "+" : ""}
        {formatCurrency(p.pnl)}
      </span>
      <span className="text-muted-foreground">
        Deposits {formatCurrency(p.deposits)}
      </span>
      <span className="text-muted-foreground">
        Withdrawals {formatCurrency(p.withdrawals)}
      </span>
    </div>
  );
}

export function PnlChart({
  data,
}: {
  data: { date: string; pnl: number; deposits: number; withdrawals: number }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">
          Daily P&amp;L (30 days)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ChartContainer config={pnlConfig} className="h-[220px] w-full md:h-[260px] lg:h-[300px]">
          <BarChart data={data} accessibilityLayer>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(v) => v.slice(5)}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              width={70}
              tickFormatter={formatCompactUsd}
            />
            <ChartTooltip content={<PnlTooltip />} />
            <Bar
              dataKey="pnl"
              radius={[4, 4, 0, 0]}
              animationDuration={700}
              animationEasing="ease-out"
            >
              {data.map((d) => (
                <Cell key={d.date} fill={d.pnl >= 0 ? PNL_UP : PNL_DOWN} />
              ))}
            </Bar>
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  );
}
