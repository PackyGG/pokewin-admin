"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { ShieldAlert, TrendingDown, Wallet, Percent } from "lucide-react";

import { cn } from "@/lib/utils";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";
import { formatPct, formatSignedUsd } from "../../../edge-calc/math";
import { StatPanel, PanelRow } from "@/components/modern-panels";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import type { NetEdgeScenario } from "../../../system-edge-plan/_model";
import type { EdgePlanV2Projection, EdgeAfterRewardsSummary } from "../../_model-v2";
import { EMERALD, ROSE } from "../utils";
import { EmptyLever } from "./empty-lever";

const AMBER = "#f59e0b";
const NEUTRAL = "#64748b";
const THIN_NET_EDGE = 0.02;

function netEdgeColor(netEdge: number): string {
  if (netEdge < 0) return ROSE;
  if (netEdge < THIN_NET_EDGE) return AMBER;
  return EMERALD;
}

function netEdgeTextClass(netEdge: number): string {
  if (netEdge < 0) return "text-rose-600 dark:text-rose-400";
  if (netEdge < THIN_NET_EDGE) return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

function basisLabel(s: NetEdgeScenario): string {
  if (s.bases.includes("deposit-bonus")) return "wager + cost";
  if (s.bases.includes("rakeback")) return "wager-based";
  if (s.bases.includes("affiliate")) return "% of edge";
  return "";
}

const netEdgeChartConfig = {
  netPct: { label: "Net edge", color: EMERALD },
} satisfies ChartConfig;

const rewardCostChartConfig = {
  current: { label: "Current", color: "#64748b" },
  planned: { label: "Planned", color: ROSE },
} satisfies ChartConfig;

export function EdgeAfterRewardsPanel({
  summary,
}: {
  summary: EdgeAfterRewardsSummary;
}) {
  const netClass = netEdgeTextClass(summary.netEdgeAfterRewards);
  const beforeMax = Math.max(
    summary.grossEdge,
    summary.currentGrossEdge,
    summary.netEdgeAfterRewards,
    summary.currentNetEdge,
    0.001,
  );

  return (
    <StatPanel title="Edge before & after rewards" icon={Percent} accent="cyan">
      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
        House edge on wager <strong>before</strong> reward spend vs effective margin{" "}
        <strong>after</strong> all modeled levers (rakeback, rain, shards, affiliates,
        etc.). Percentages are of <strong>organic wager</strong> on the planned config
        (excl. borrow &amp; creator-coded referral volume).
      </p>

      <div className="grid gap-3 lg:grid-cols-[1fr_auto_1fr] lg:items-stretch">
        <div className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
            Before rewards
          </p>
          <p className="mt-1 text-3xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400">
            {formatPct(summary.grossEdge)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Blended gross house edge
          </p>
          <p className="mt-2 text-[10px] tabular-nums text-muted-foreground">
            Current config: {formatPct(summary.currentGrossEdge)}
          </p>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted/60">
            <div
              className="h-full rounded-full bg-emerald-500"
              style={{ width: `${Math.min(100, (summary.grossEdge / beforeMax) * 100)}%` }}
            />
          </div>
        </div>

        <div className="flex flex-col items-center justify-center gap-1 px-1 py-2 lg:py-0">
          <span className="hidden text-2xl text-muted-foreground lg:inline">→</span>
          <span className="rounded-full border bg-background px-2.5 py-1 text-center text-[10px] font-semibold tabular-nums text-rose-600 dark:text-rose-400">
            −{formatPct(summary.plannedRewardDrag)}
          </span>
          <span className="text-[10px] text-muted-foreground">reward drag</span>
        </div>

        <div className="rounded-xl border border-cyan-500/25 bg-cyan-500/5 px-4 py-3">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-300">
            After rewards
          </p>
          <p className={cn("mt-1 text-3xl font-bold tabular-nums", netClass)}>
            {formatPct(summary.netEdgeAfterRewards)}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Net edge left on organic wager</p>
          <p className="mt-2 text-[10px] tabular-nums text-muted-foreground">
            Current config: {formatPct(summary.currentNetEdge)}
            {summary.netEdgeDelta !== 0 && (
              <>
                {" "}
                ·{" "}
                <span
                  className={
                    summary.netEdgeDelta >= 0
                      ? "text-emerald-600 dark:text-emerald-400"
                      : "text-rose-600 dark:text-rose-400"
                  }
                >
                  {summary.netEdgeDelta >= 0 ? "+" : ""}
                  {formatPct(summary.netEdgeDelta)} vs current
                </span>
              </>
            )}
          </p>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted/60">
            <div
              className={cn(
                "h-full rounded-full",
                summary.netEdgeAfterRewards < 0
                  ? "bg-rose-500"
                  : summary.netEdgeAfterRewards < THIN_NET_EDGE
                    ? "bg-amber-500"
                    : "bg-emerald-500",
              )}
              style={{
                width: `${Math.min(100, Math.max(0, (summary.netEdgeAfterRewards / beforeMax) * 100))}%`,
              }}
            />
          </div>
        </div>
      </div>

      <div className="mt-3 grid gap-2 rounded-lg border bg-background/40 px-3 py-2.5 text-xs sm:grid-cols-3">
        <div>
          <span className="text-muted-foreground">Before (USD on organic wager)</span>
          <p className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
            {formatCompactUsd(summary.grossEdge * summary.wager)}
          </p>
        </div>
        <div>
          <span className="text-muted-foreground">Reward spend</span>
          <p className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">
            −{formatCompactUsd(summary.plannedRewardDrag * summary.wager)}
          </p>
        </div>
        <div>
          <span className="text-muted-foreground">After (planned NGR)</span>
          <p className={cn("font-semibold tabular-nums", netClass)}>
            {formatCompactUsd(summary.netEdgeAfterRewards * summary.wager)}
          </p>
        </div>
      </div>

      {summary.netEdgeAfterRewards < 0 && (
        <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] leading-relaxed text-rose-600 dark:text-rose-400">
          Planned rewards exceed gross edge — the house loses money on every dollar
          wagered at this config ({formatPct(summary.netEdgeAfterRewards)} after
          rewards).
        </p>
      )}
      {summary.netEdgeAfterRewards >= 0 &&
        summary.netEdgeAfterRewards < THIN_NET_EDGE && (
          <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-600 dark:text-amber-400">
            Thin margin — less than {formatPct(THIN_NET_EDGE)} edge left after
            rewards.
          </p>
        )}

      {summary.leverDrags.length > 0 && (
        <div className="mt-4 space-y-0.5 border-t pt-3">
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            What erodes edge (% of organic wager)
          </p>
          {summary.leverDrags.map((l) => (
            <div key={l.key}>
              <PanelRow
                label={l.label}
                value={
                  <span className="flex items-center gap-2 tabular-nums">
                    <span className="text-xs text-muted-foreground">
                      {formatCompactUsd(l.plannedCostUsd)}
                    </span>
                    <span
                      className={cn(
                        "w-16 text-right font-semibold",
                        l.dragPct > 0
                          ? "text-rose-600 dark:text-rose-400"
                          : l.dragPct < 0
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-muted-foreground",
                      )}
                    >
                      {l.dragPct === 0
                        ? "—"
                        : `${l.dragPct > 0 ? "−" : "+"}${formatPct(Math.abs(l.dragPct))}`}
                    </span>
                  </span>
                }
              />
              {l.dragNote ? (
                <p className="pb-1 pl-0 text-[10px] leading-snug text-muted-foreground">
                  {l.dragNote}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </StatPanel>
  );
}

export function NetEdgeByScenarioPanel({
  scenarios,
}: {
  scenarios: NetEdgeScenario[];
}) {
  const data = scenarios.map((s) => ({
    key: s.key,
    label: s.label,
    netPct: s.netEdge * 100,
  }));

  const anyNegative = scenarios.some((s) => s.netEdge < 0);
  const anyThin = scenarios.some((s) => s.netEdge >= 0 && s.netEdge < THIN_NET_EDGE);
  const chartHeight = Math.max(260, data.length * 28);

  return (
    <StatPanel title="Net edge by scenario" icon={ShieldAlert} accent="amber">
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        Where the house edge ends up after reward erosion. Affiliate tiers pay a{" "}
        <span className="font-medium text-foreground">% of house edge</span> (effective
        wager drag = edge share × house edge). Rakeback is a straight{" "}
        <span className="font-medium text-foreground">% of wager</span>. Deposit bonus
        uses realized cost ÷ wager.
      </p>

      {scenarios.length === 0 ? (
        <EmptyLever note="No scenarios to show — set a planned edge above." />
      ) : (
        <>
          <ChartContainer
            config={netEdgeChartConfig}
            className="aspect-auto w-full min-w-0"
            style={{ height: chartHeight }}
          >
            <BarChart
              data={data}
              layout="vertical"
              margin={{ left: 12, right: 56, top: 8, bottom: 8 }}
              barCategoryGap="18%"
              accessibilityLayer
            >
              <CartesianGrid horizontal={false} />
              <XAxis
                type="number"
                tickLine={false}
                axisLine={false}
                tickFormatter={(v) => `${Number(v).toFixed(1)}%`}
                tick={{ fontSize: 11 }}
              />
              <YAxis
                type="category"
                dataKey="label"
                tickLine={false}
                axisLine={false}
                width={150}
                tick={{ fontSize: 11 }}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(v) => `${Number(v).toFixed(2)}% net edge`}
                  />
                }
              />
              <ReferenceLine x={0} stroke="var(--border)" strokeWidth={1} />
              <Bar dataKey="netPct" radius={[0, 3, 3, 0]} barSize={16}>
                {data.map((d) => (
                  <Cell key={d.key} fill={netEdgeColor(d.netPct / 100)} />
                ))}
                <LabelList
                  dataKey="netPct"
                  position="right"
                  formatter={(v: number) => `${v.toFixed(2)}%`}
                  className="fill-foreground"
                  style={{ fontSize: 10 }}
                />
              </Bar>
            </BarChart>
          </ChartContainer>

          <div className="mt-3 space-y-0.5 border-t pt-3">
            {scenarios.map((s) => (
              <div
                key={s.key}
                className="flex items-center justify-between gap-3 py-1 text-sm"
                title={s.note}
              >
                <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <span className={cn("truncate", s.isBase && "font-semibold")}>
                    {s.label}
                  </span>
                  {!s.isBase && basisLabel(s) && (
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                      {basisLabel(s)}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-2 tabular-nums">
                  {!s.isBase && (
                    <span className="text-xs text-muted-foreground">
                      {formatPct(s.grossEdge)} − {formatPct(s.erosion)} →
                    </span>
                  )}
                  <span
                    className={cn(
                      "w-16 text-right font-semibold",
                      netEdgeTextClass(s.netEdge),
                    )}
                  >
                    {formatPct(s.netEdge)}
                  </span>
                </span>
              </div>
            ))}
          </div>

          {(anyNegative || anyThin) && (
            <p
              className={cn(
                "mt-3 rounded-lg border px-3 py-2 text-[11px] leading-relaxed",
                anyNegative
                  ? "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
                  : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
              )}
            >
              {anyNegative
                ? "At least one profile drives net edge below zero at the planned edge."
                : `At least one profile leaves a thin net edge (<${formatPct(THIN_NET_EDGE)}).`}
            </p>
          )}
        </>
      )}
    </StatPanel>
  );
}

export function RewardCostComparisonChart({
  projection,
}: {
  projection: EdgePlanV2Projection;
}) {
  const data = projection.levers
    .filter((l) => l.currentCost > 0 || l.plannedCost > 0)
    .map((l) => ({
      lever: l.label,
      current: l.currentCost,
      planned: l.plannedCost,
    }));

  const chartHeight = Math.max(220, data.length * 56);

  return (
    <StatPanel title="Reward cost — current vs planned" icon={Wallet} accent="rose">
      {data.length === 0 ? (
        <EmptyLever note="No realized reward cost in this window to compare." />
      ) : (
        <ChartContainer
          config={rewardCostChartConfig}
          className="aspect-auto w-full min-w-0"
          style={{ height: chartHeight }}
        >
          <BarChart
            data={data}
            layout="vertical"
            margin={{ left: 12, right: 72, top: 8, bottom: 8 }}
            barCategoryGap="20%"
            accessibilityLayer
          >
            <CartesianGrid horizontal={false} />
            <XAxis
              type="number"
              tickLine={false}
              axisLine={false}
              tickFormatter={formatCompactUsd}
              tick={{ fontSize: 11 }}
            />
            <YAxis
              type="category"
              dataKey="lever"
              tickLine={false}
              axisLine={false}
              width={148}
              tick={{ fontSize: 11 }}
            />
            <ChartTooltip
              content={
                <ChartTooltipContent formatter={(v) => formatCurrency(Number(v))} />
              }
            />
            <Bar
              dataKey="current"
              fill="var(--color-current)"
              radius={[0, 3, 3, 0]}
              barSize={18}
            />
            <Bar dataKey="planned" radius={[0, 3, 3, 0]} barSize={18}>
              {data.map((d, i) => (
                <Cell
                  key={i}
                  fill={
                    d.planned < d.current
                      ? EMERALD
                      : d.planned > d.current
                        ? ROSE
                        : NEUTRAL
                  }
                />
              ))}
              <LabelList
                dataKey="planned"
                position="right"
                formatter={(v: number) => formatCompactUsd(v)}
                className="fill-foreground"
                style={{ fontSize: 10 }}
              />
            </Bar>
          </BarChart>
        </ChartContainer>
      )}
    </StatPanel>
  );
}

export function LeverBreakdownPanel({
  projection,
}: {
  projection: EdgePlanV2Projection;
}) {
  return (
    <StatPanel title="Cost delta by lever" icon={TrendingDown} accent="purple">
      <div className="space-y-0.5">
        {projection.levers.map((l) => {
          const saving = -l.deltaCost;
          const tone =
            l.deltaCost === 0
              ? "text-muted-foreground"
              : saving > 0
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-rose-600 dark:text-rose-400";
          return (
            <PanelRow
              key={l.key}
              label={l.label}
              value={
                <span className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">
                    {formatCompactUsd(l.currentCost)} → {formatCompactUsd(l.plannedCost)}
                  </span>
                  <span className={cn("w-20 text-right tabular-nums", tone)}>
                    {l.deltaCost === 0 ? "—" : formatSignedUsd(saving)}
                  </span>
                </span>
              }
            />
          );
        })}
      </div>
    </StatPanel>
  );
}
