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
import { Activity, ChartNoAxesCombined, Radio } from "lucide-react";

import { HostLink } from "@/components/host-link";
import { SectionHeading } from "@/components/modern-panels";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { useSseStream } from "@/lib/hooks/use-sse";
import type {
  AntifraudActionFeedItem,
  AntifraudOverviewDay,
} from "@/lib/antifraud/overview";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import {
  MONITOR_STREAM_PATH,
  parseMonitorFrame,
} from "./monitor-stream";

const MAX_FEED_ITEMS = 24;
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
    <div className="grid h-full gap-4 lg:grid-cols-2">
      <section className="flex min-h-[390px] flex-col space-y-3 rounded-xl border border-border/60 bg-card p-3 sm:p-4">
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
        <ChartContainer config={fiatConfig} className="min-h-0 flex-1 w-full">
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

      <section className="flex min-h-[390px] flex-col space-y-3 rounded-xl border border-border/60 bg-card p-3 sm:p-4">
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
        <ChartContainer config={accountConfig} className="min-h-0 flex-1 w-full">
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

function feedDot(type: AntifraudActionFeedItem["type"]): string {
  switch (type) {
    case "fiat_deposit":
      return "bg-emerald-500";
    case "banned":
      return "bg-rose-500";
    case "locked":
    case "kyc_requested":
      return "bg-amber-500";
    case "kyc_reviewed":
      return "bg-cyan-500";
    case "high_risk_signup":
      return "bg-orange-500";
    default:
      return "bg-blue-500";
  }
}

export function OverviewActionFeed({
  initialItems,
}: {
  initialItems: AntifraudActionFeedItem[];
}) {
  const [items, setItems] = React.useState(initialItems);
  const [connection, setConnection] = React.useState<
    "connecting" | "live" | "offline"
  >("connecting");

  useSseStream<unknown>(
    MONITOR_STREAM_PATH,
    {
      onInit: () => {},
      onRow: (raw) => {
        const frame = parseMonitorFrame(raw);
        if (!frame) return;
        if (frame.kind === "transport") {
          // "unconfigured"/terminal/error must read as offline, not as a
          // permanent "connecting" that looks like a transient blip.
          setConnection(
            frame.state === "open"
              ? "live"
              : frame.state === "connecting"
                ? "connecting"
                : "offline",
          );
          return;
        }
        if (frame.kind !== "activity") return;
        setConnection("live");
        const event = frame.event;
        const item: AntifraudActionFeedItem = {
          id: `live:${event.id}`,
          type:
            event.type === "signup.assessed"
              ? "high_risk_signup"
              : "signal",
          title: event.title,
          detail: event.detail,
          occurredAt: event.at,
          userId: event.userId,
          href: event.userId
            ? `/antifraud/reviews?search=${encodeURIComponent(event.userId)}`
            : null,
          amountCents: null,
        };
        setItems((current) =>
          current.some((existing) => existing.id === item.id)
            ? current
            : [item, ...current].slice(0, MAX_FEED_ITEMS),
        );
      },
      onReconnect: () => setConnection("connecting"),
      onGiveUp: () => setConnection("offline"),
      onStale: () => setConnection("offline"),
    },
    { resumeParam: "after", staleAfterMs: 45_000 },
  );

  return (
    <section className="flex h-[300px] min-h-0 flex-col rounded-xl border border-border/60 bg-card">
      <div className="border-b border-border/60 px-3 py-3 sm:px-4">
        <SectionHeading
          icon={Radio}
          title="Live action feed"
          action={
            <span
              role="status"
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
                connection === "live"
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : connection === "offline"
                    ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                    : "border-border bg-muted/50 text-muted-foreground",
              )}
            >
              {connection}
            </span>
          }
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="flex h-full items-center justify-center px-5 text-center text-xs text-muted-foreground">
            No persisted Fraud activity is available yet. New monitor events
            will appear here live.
          </div>
        ) : (
          <ul
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            className="divide-y divide-border/60"
          >
            {items.map((item) => {
              const body = (
                <>
                  <span
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      feedDot(item.type),
                    )}
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-semibold">
                      {item.title}
                    </span>
                    <span className="mt-0.5 line-clamp-2 block text-[11px] text-muted-foreground">
                      {item.detail}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    {item.amountCents !== null && (
                      <span className="block text-xs font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatCurrency(item.amountCents / 100)}
                      </span>
                    )}
                    <span className="block text-[10px] text-muted-foreground">
                      {formatRelative(item.occurredAt)}
                    </span>
                  </span>
                </>
              );
              return (
                <li key={item.id}>
                  {item.href ? (
                    <HostLink
                      href={item.href}
                      className="flex gap-2.5 px-3 py-3 hover:bg-muted/40 sm:px-4"
                    >
                      {body}
                    </HostLink>
                  ) : (
                    <div className="flex gap-2.5 px-3 py-3 sm:px-4">
                      {body}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
