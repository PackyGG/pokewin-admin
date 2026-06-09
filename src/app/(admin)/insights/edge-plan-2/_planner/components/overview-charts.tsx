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
import { ShieldAlert, TrendingDown, Wallet } from "lucide-react";

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
import type {
  EdgePlanV2Projection,
  BlendedEdgeBreakdown,
} from "../../_model-v2";
import {
  CHART_COLOR,
  TEXT_TONE,
  THIN_NET_EDGE,
  netEdgeChartColor,
  netEdgeTextTone,
} from "../colors";
import { EmptyLever } from "./empty-lever";

function basisLabel(s: NetEdgeScenario): string {
  if (s.bases.includes("deposit-bonus")) return "wager + cost";
  if (s.bases.includes("rakeback")) return "wager-based";
  if (s.bases.includes("affiliate")) return "% of edge";
  return "";
}

const netEdgeChartConfig = {
  netPct: { label: "Net edge", color: CHART_COLOR.emerald },
} satisfies ChartConfig;

const rewardCostChartConfig = {
  current: { label: "Current", color: CHART_COLOR.neutral },
  planned: { label: "Planned", color: CHART_COLOR.rose },
} satisfies ChartConfig;

export function BlendedEdgeBreakdownPanel({
  breakdown,
  compact = false,
}: {
  breakdown: BlendedEdgeBreakdown;
  compact?: boolean;
}) {
  const battles = breakdown.lines.find((l) => l.type === "battles");
  const dilutionPts = breakdown.battlesDilutionPoints * 100;

  return (
    <div
      className={cn(
        "rounded-lg border bg-background/40",
        compact ? "px-3 py-2.5" : "px-4 py-3",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Blended house edge
        </p>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-right">
          <span
            className={cn(
              "text-lg font-bold tabular-nums",
              TEXT_TONE.emerald,
            )}
          >
            {formatPct(breakdown.allWagerBlendedEdge)}
          </span>
          <span className="text-[11px] text-muted-foreground">
            on all wager ({formatCompactUsd(breakdown.allWager)})
          </span>
        </div>
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
        Planned GGR {formatCompactUsd(breakdown.plannedGgr)} ÷ total customer wager.
        Battles add volume at <strong>0%</strong> planning margin — they dilute this
        headline. Upgrader is included in the blend when it has wager.
      </p>

      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2.5 py-2">
          <p className="text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
            All customer wager
          </p>
          <p className={cn("text-xl font-bold tabular-nums", TEXT_TONE.emerald)}>
            {formatPct(breakdown.allWagerBlendedEdge)}
          </p>
          <p className="text-[10px] text-muted-foreground">
            GGR ÷ packs + battles + upgrader
          </p>
        </div>
        <div className="rounded-md border border-cyan-500/20 bg-cyan-500/5 px-2.5 py-2">
          <p className="text-[10px] font-medium text-cyan-700 dark:text-cyan-300">
            Margin-bearing wager
          </p>
          <p className="text-xl font-bold tabular-nums text-cyan-600 dark:text-cyan-400">
            {formatPct(breakdown.marginBearingBlendedEdge)}
          </p>
          <p className="text-[10px] text-muted-foreground">
            GGR ÷ packs + upgrader ({formatCompactUsd(breakdown.marginBearingWager)})
          </p>
        </div>
      </div>

      {!compact && (
        <div className="mt-3 space-y-1 border-t pt-2">
          {breakdown.lines.map((line) => (
            <div
              key={line.type}
              className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5 text-[11px]"
            >
              <span className="text-muted-foreground">
                {line.label}
                {line.type === "battles" && (
                  <span className="ml-1 text-[10px]">· 0% margin · dilutes blend</span>
                )}
              </span>
              <span className="tabular-nums text-foreground">
                {formatPct(line.edge)} × {formatCompactUsd(line.wager)} ={" "}
                {formatCompactUsd(line.plannedGgr)} GGR
              </span>
            </div>
          ))}
        </div>
      )}

      {battles && battles.wager > 0 && dilutionPts > 0.05 && (
        <p className={cn("mt-2 text-[10px] leading-relaxed", TEXT_TONE.amber)}>
          Battle wager {formatCompactUsd(battles.wager)} at 0% planning edge pulls the
          all-wager blend down by ~{dilutionPts.toFixed(1)} pts vs the{" "}
          {formatPct(breakdown.marginBearingBlendedEdge)} packs+upgrader read — not a
          simple average of the sliders.
        </p>
      )}
    </div>
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

  // Compact summary: worst / best net edge across the profiles, replacing the
  // old full text table that duplicated the bars.
  const sorted = [...scenarios].sort((a, b) => a.netEdge - b.netEdge);
  const worst = sorted[0];
  const best = sorted[sorted.length - 1];

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
              <Bar
                dataKey="netPct"
                radius={[0, 3, 3, 0]}
                barSize={16}
                animationDuration={700}
                animationEasing="ease-out"
              >
                {data.map((d) => (
                  <Cell key={d.key} fill={netEdgeChartColor(d.netPct / 100)} />
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

          {worst && best && (
            <div className="mt-3 grid grid-cols-1 gap-2 border-t pt-3 sm:grid-cols-2">
              <div
                className="flex items-baseline justify-between gap-2"
                title={worst.note}
              >
                <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                  Worst · {worst.label}
                  {basisLabel(worst) && (
                    <span className="ml-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                      {basisLabel(worst)}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "shrink-0 font-semibold tabular-nums",
                    netEdgeTextTone(worst.netEdge),
                  )}
                >
                  {formatPct(worst.netEdge)}
                </span>
              </div>
              <div
                className="flex items-baseline justify-between gap-2"
                title={best.note}
              >
                <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                  Best · {best.label}
                  {basisLabel(best) && (
                    <span className="ml-1 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                      {basisLabel(best)}
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "shrink-0 font-semibold tabular-nums",
                    netEdgeTextTone(best.netEdge),
                  )}
                >
                  {formatPct(best.netEdge)}
                </span>
              </div>
            </div>
          )}

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
              animationDuration={700}
              animationEasing="ease-out"
            />
            <Bar
              dataKey="planned"
              radius={[0, 3, 3, 0]}
              barSize={18}
              animationDuration={700}
              animationEasing="ease-out"
            >
              {data.map((d, i) => (
                <Cell
                  key={i}
                  fill={
                    d.planned < d.current
                      ? CHART_COLOR.emerald
                      : d.planned > d.current
                        ? CHART_COLOR.rose
                        : CHART_COLOR.neutral
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
                ? TEXT_TONE.emerald
                : TEXT_TONE.rose;
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
