"use client";

import * as React from "react";
import {
  Coins,
  Gauge,
  Percent,
  TrendingDown,
  TrendingUp,
  Wallet,
} from "lucide-react";

import { KpiTile, StatPanel } from "@/components/modern-panels";
import { AnimatedNumber } from "@/components/animated-number";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCompactUsd } from "@/lib/utils/format";
import { formatPct, formatSignedUsd } from "../../edge-calc/math";
import {
  WAGER_SCENARIO_PRESET_MULTS,
  type BlendedEdgeBreakdown,
  type EdgeAfterRewardsSummary,
  type EdgePlanV2Projection,
  type WagerScenarioState,
} from "../_model-v2";
import {
  TEXT_TONE,
  houseAccent,
  netEdgeTextTone,
} from "./colors";

/** "1×" / "1.5×" / "3×" label for a wager-scenario multiplier. */
function formatWagerMultLabel(mult: number): string {
  if (!Number.isFinite(mult) || mult <= 0) return "1×";
  const s =
    mult % 1 === 0 ? mult.toFixed(0) : mult.toFixed(1).replace(/\.0$/, "");
  return `${s}×`;
}

/**
 * Hero summary for the Edge Plan 2.0 planner.
 *
 * Consolidates the old triplicated edge readout into ONE place:
 *   1. A profit-delta StatPanel (house-POV accent) with an animated hero
 *      number and the monthly / annual extrapolation + NGR context.
 *   2. A SINGLE gross -> net edge waterfall (before rewards -> reward drag ->
 *      after rewards), each leg carrying its "was ..." current value plus the
 *      signed net-edge delta vs current.
 *   3. A trimmed 6-tile KpiTile strip (string-typed values — no AnimatedNumber
 *      inside tiles, since KpiTile.value is `string`).
 *
 * All props are plain serializable data + an `actions` node (the reset +
 * presets cluster, composed by the shell) + the wager-scenario state/handler
 * for the pills next to the waterfall. House-POV finance colors: house edge /
 * P&L positive -> emerald, negative -> rose; near-break-even net edge -> amber
 * (via `netEdgeTextTone`). Reduce-motion is respected by AnimatedNumber and the
 * decorative panel glows in modern-panels.
 */
export function EdgePlanV2HeroSummary({
  projection,
  edgeAfterRewards,
  blendBreakdown,
  rawMathEdge,
  wagerScenario,
  onWagerScenarioChange,
  actions,
}: {
  projection: EdgePlanV2Projection;
  edgeAfterRewards: EdgeAfterRewardsSummary;
  blendBreakdown: BlendedEdgeBreakdown;
  /**
   * Raw mathematical edge (simple mean of the packs & upgrader planned
   * edges, no wager weighting — `rawMathEdgeV2`). Shown as a labeled chip
   * NEXT TO the wager-weighted figure, never replacing it (owner spec #2).
   */
  rawMathEdge?: number;
  wagerScenario: WagerScenarioState;
  onWagerScenarioChange: (next: WagerScenarioState) => void;
  /** Reset + presets cluster, rendered in the profit panel's action slot. */
  actions?: React.ReactNode;
}) {
  const profitAccent = houseAccent(projection.profitDelta);
  const profitTextTone =
    profitAccent === "emerald" ? TEXT_TONE.emerald : TEXT_TONE.rose;
  const netTextTone = netEdgeTextTone(edgeAfterRewards.netEdgeAfterRewards);

  const activePresetMult =
    Number.isFinite(wagerScenario.presetMult) && wagerScenario.presetMult > 0
      ? wagerScenario.presetMult
      : 1;
  const scenarioActive = Math.abs(edgeAfterRewards.wagerScenarioMult - 1) > 0.001;
  const wagerMultLabel = formatWagerMultLabel(edgeAfterRewards.wagerScenarioMult);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        {/* ── Profit delta ─────────────────────────────────────────── */}
        <StatPanel
          title="Projected profit delta"
          icon={Gauge}
          accent={profitAccent}
          action={actions}
        >
          <p
            className={cn(
              "text-3xl font-bold leading-tight tracking-tight tabular-nums sm:text-4xl",
              profitTextTone,
            )}
          >
            <AnimatedNumber
              value={projection.profitDelta}
              format="currency"
              duration={700}
            />
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatSignedUsd(projection.monthlyProfitDelta)}/mo ·{" "}
            {formatSignedUsd(projection.annualProfitDelta)}/yr extrapolated
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 border-t pt-3">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Current NGR
              </p>
              <p className="truncate font-semibold tabular-nums">
                {formatCompactUsd(projection.currentNgr)}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Planned NGR
              </p>
              <p
                className={cn(
                  "truncate font-semibold tabular-nums",
                  profitTextTone,
                )}
              >
                {formatCompactUsd(projection.plannedNgr)}
              </p>
            </div>
          </div>
        </StatPanel>

        {/* ── Single gross -> net edge waterfall ───────────────────── */}
        <StatPanel title="Edge before & after rewards" icon={Percent} accent="cyan">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 text-xs text-muted-foreground">
              House edge on wager <strong>before</strong> reward spend, the planned
              reward drag, and the net edge <strong>after</strong>.
            </p>
            <div className="flex shrink-0 flex-wrap items-center gap-1.5">
              {WAGER_SCENARIO_PRESET_MULTS.map((mult) => {
                const active = Math.abs(activePresetMult - mult) < 0.001;
                return (
                  <Button
                    key={mult}
                    type="button"
                    size="xs"
                    variant={active ? "default" : "outline"}
                    onClick={() => onWagerScenarioChange({ presetMult: mult })}
                  >
                    {formatWagerMultLabel(mult)}
                  </Button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:items-stretch">
            {/* Before rewards — house gross edge (emerald). */}
            <div className="min-w-0 rounded-xl border border-emerald-500/25 bg-emerald-500/5 px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                Before rewards
              </p>
              <p
                className={cn(
                  "mt-1 text-2xl font-bold tabular-nums sm:text-3xl",
                  TEXT_TONE.emerald,
                )}
              >
                {formatPct(edgeAfterRewards.grossEdge)}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Wager-weighted gross edge · packs + upgrader
              </p>
              <p className="mt-2 text-[10px] tabular-nums text-muted-foreground">
                was {formatPct(edgeAfterRewards.currentGrossEdge)} (default) ·{" "}
                {formatPct(blendBreakdown.allWagerBlendedEdge)} on all wager
              </p>
              {rawMathEdge != null && (
                <p className="mt-1.5 inline-flex items-center gap-1 rounded-full border bg-background px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
                  Raw math edge {formatPct(rawMathEdge)}
                  <span className="font-normal text-muted-foreground/70">
                    · simple mean, no weighting
                  </span>
                </p>
              )}
            </div>

            {/* Reward drag — house cost (rose, signed minus). */}
            <div className="flex flex-col items-center justify-center gap-1 px-1 py-2 lg:py-0">
              <span className="hidden text-2xl text-muted-foreground lg:inline">
                →
              </span>
              <span
                className={cn(
                  "rounded-full border bg-background px-2.5 py-1 text-center text-[11px] font-semibold tabular-nums",
                  TEXT_TONE.rose,
                )}
              >
                −{formatPct(edgeAfterRewards.plannedRewardDrag)}
              </span>
              <span className="text-[10px] text-muted-foreground">reward drag</span>
            </div>

            {/* After rewards — net edge (emerald / amber / rose). */}
            <div className="min-w-0 rounded-xl border border-cyan-500/25 bg-cyan-500/5 px-4 py-3">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-cyan-700 dark:text-cyan-300">
                After rewards
              </p>
              <p
                className={cn(
                  "mt-1 text-2xl font-bold tabular-nums sm:text-3xl",
                  netTextTone,
                )}
              >
                {formatPct(edgeAfterRewards.netEdgeAfterRewards)}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Net edge left on {wagerMultLabel} wager
              </p>
              <p className="mt-2 text-[10px] tabular-nums text-muted-foreground">
                was {formatPct(edgeAfterRewards.currentNetEdge)}
                {edgeAfterRewards.netEdgeDelta !== 0 && (
                  <>
                    {" "}
                    ·{" "}
                    <span
                      className={
                        edgeAfterRewards.netEdgeDelta >= 0
                          ? TEXT_TONE.emerald
                          : TEXT_TONE.rose
                      }
                    >
                      {edgeAfterRewards.netEdgeDelta >= 0 ? "+" : ""}
                      {formatPct(edgeAfterRewards.netEdgeDelta)} vs current
                    </span>
                  </>
                )}
              </p>
            </div>
          </div>

          {scenarioActive && (
            <p className="mt-3 text-[10px] leading-relaxed text-amber-600 dark:text-amber-400">
              Fixed-window rewards (deposit bonus, races, raffles, daily packs,
              signup, rain, motha) hold planned $ for the window — their drag
              dilutes at higher wager. Rakeback and affiliate commission scale $
              with wager; affiliate worst-case tier drag stays % of edge.
            </p>
          )}
        </StatPanel>
      </div>

      {/* ── Trimmed 6-tile KPI strip (string values only) ──────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <KpiTile
          label="Before rewards"
          value={formatPct(edgeAfterRewards.grossEdge)}
          sub={`all wager · ${formatPct(blendBreakdown.marginBearingBlendedEdge)} packs+upg`}
          icon={TrendingUp}
          accent="emerald"
        />
        <KpiTile
          label="After rewards"
          value={formatPct(edgeAfterRewards.netEdgeAfterRewards)}
          sub={`−${formatPct(edgeAfterRewards.plannedRewardDrag)} drag`}
          icon={Percent}
          accent={
            edgeAfterRewards.netEdgeAfterRewards < 0
              ? "rose"
              : edgeAfterRewards.netEdgeAfterRewards < 0.02
                ? "amber"
                : "cyan"
          }
        />
        <KpiTile
          label="Wager (30d)"
          value={formatCompactUsd(projection.plannedWager)}
          sub="All games · borrow incl. · observed volume"
          icon={Coins}
          accent="blue"
        />
        <KpiTile
          label="Planned GGR"
          value={formatCompactUsd(projection.plannedGgr)}
          sub={`${formatPct(blendBreakdown.allWagerBlendedEdge)} all wager`}
          icon={TrendingUp}
          accent="emerald"
        />
        <KpiTile
          label="Reward cost"
          value={formatCompactUsd(projection.plannedRewardCost)}
          sub={formatSignedUsd(projection.rewardCostDelta)}
          icon={Wallet}
          accent="rose"
        />
        <KpiTile
          label="Planned NGR"
          value={formatCompactUsd(projection.plannedNgr)}
          sub={`${formatSignedUsd(projection.profitDelta)} vs current`}
          icon={projection.profitDelta >= 0 ? Gauge : TrendingDown}
          accent={houseAccent(projection.profitDelta) === "emerald" ? "cyan" : "rose"}
        />
      </div>
    </div>
  );
}
