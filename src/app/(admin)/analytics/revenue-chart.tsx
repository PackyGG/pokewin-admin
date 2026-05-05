"use client";

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { formatCompactUsd } from "@/lib/utils/format";

type RevenueDailyPoint = {
  date: string;
  packWager: number;
  battleWager: number;
  battleSponsorship: number;
  shippingFees: number;
  battleRefund: number;
  cardSale: number;
  bonuses: number;
  rakeback: number;
  affiliate: number;
  rainRace: number;
  signupPack: number;
  creatorTip: number;
  vouchers: number;
  waitlist: number;
};

const inflowConfig = {
  packWager: { label: "Pack Wagers", color: "var(--color-chart-1)" },
  battleWager: { label: "Battle Wagers", color: "var(--color-chart-2)" },
  battleSponsorship: {
    label: "Battle Sponsorship",
    color: "var(--color-chart-3)",
  },
  shippingFees: { label: "Shipping Fees", color: "var(--color-chart-4)" },
} satisfies ChartConfig;

const outflowConfig = {
  cardSale: { label: "Card Sales", color: "var(--color-chart-1)" },
  battleRefund: { label: "Battle Refunds", color: "var(--color-chart-2)" },
  bonuses: { label: "Bonuses & Promos", color: "var(--color-chart-3)" },
  rakeback: { label: "Rakeback", color: "var(--color-chart-4)" },
  affiliate: { label: "Affiliate", color: "var(--color-chart-5)" },
  rainRace: { label: "Rain / Race", color: "var(--color-chart-1)" },
  signupPack: { label: "Signup Packs", color: "var(--color-chart-2)" },
  creatorTip: { label: "Creator Tips", color: "var(--color-chart-3)" },
  vouchers: { label: "Vouchers", color: "var(--color-chart-4)" },
  waitlist: { label: "Waitlist", color: "var(--color-chart-5)" },
} satisfies ChartConfig;

/**
 * Two stacked area charts side by side — inflow stack on the left,
 * outflow stack on the right. The admin can eyeball where each type
 * of activity clusters in time.
 */
export function RevenueStackedCharts({
  daily,
}: {
  daily: RevenueDailyPoint[];
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
          Inflows (house revenue)
        </h4>
        <ChartContainer config={inflowConfig} className="h-[260px] w-full md:h-[320px] lg:h-[360px]">
          <AreaChart data={daily} accessibilityLayer>
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
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => `$${Number(value).toFixed(2)}`}
                />
              }
            />
            {(["packWager", "battleWager", "battleSponsorship", "shippingFees"] as const).map(
              (k, i) => (
                <Area
                  key={k}
                  type="monotone"
                  dataKey={k}
                  stackId="inflow"
                  stroke={`var(--color-${k})`}
                  fill={`var(--color-${k})`}
                  fillOpacity={0.4}
                  strokeWidth={1.5}
                  animationDuration={700}
                  animationEasing="ease-out"
                  animationBegin={i * 40}
                />
              ),
            )}
          </AreaChart>
        </ChartContainer>
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
          Outflows (paid to users)
        </h4>
        <ChartContainer config={outflowConfig} className="h-[260px] w-full md:h-[320px] lg:h-[360px]">
          <AreaChart data={daily} accessibilityLayer>
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
            <ChartTooltip
              content={
                <ChartTooltipContent
                  formatter={(value) => `$${Number(value).toFixed(2)}`}
                />
              }
            />
            {(
              [
                "cardSale",
                "battleRefund",
                "bonuses",
                "rakeback",
                "affiliate",
                "rainRace",
                "signupPack",
                "creatorTip",
                "vouchers",
                "waitlist",
              ] as const
            ).map((k, i) => (
              <Area
                key={k}
                type="monotone"
                dataKey={k}
                stackId="outflow"
                stroke={`var(--color-${k})`}
                fill={`var(--color-${k})`}
                fillOpacity={0.4}
                strokeWidth={1.5}
                animationDuration={700}
                animationEasing="ease-out"
                animationBegin={i * 20}
              />
            ))}
          </AreaChart>
        </ChartContainer>
      </div>
    </div>
  );
}
