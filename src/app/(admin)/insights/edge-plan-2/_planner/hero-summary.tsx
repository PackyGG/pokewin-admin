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
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";
import { formatPct, formatSignedUsd } from "../../edge-calc/math";
import {
  WAGER_SCENARIO_PRESET_MULTS,
  formatRawMathEdgePctV2,
  formatWagerMultLabel,
  type BlendedEdgeBreakdown,
  type EdgeAfterRewardsSummary,
  type WagerScenarioState,
  type WagerScenarioView,
} from "../_model-v2";
import {
  TEXT_TONE,
  houseAccent,
  netEdgeTextTone,
} from "./colors";

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
 * SCENARIO-AWARE (owner fix 2026-06-12): every $ figure here reads from the
 * `scenario` view (`applyWagerScenarioV2`) so the 1×–5× wager chips move the
 * WHOLE hero — profit delta, NGR context and the KPI strip — not just the
 * edge waterfall. At 1× the view is the exact base projection (identity);
 * at any other multiplier every affected figure is LOUDLY labeled
 * "at N× wager" (amber), per the page-wide scenario semantics: rakeback /
 * affiliate / shards scale $ with wager, fixed-window $ budgets and
 * deposit-fee revenue stay flat.
 *
 * All props are plain serializable data + an `actions` node (the reset +
 * presets cluster, composed by the shell) + the wager-scenario state/handler
 * for the pills next to the waterfall. House-POV finance colors: house edge /
 * P&L positive -> emerald, negative -> rose; near-break-even net edge -> amber
 * (via `netEdgeTextTone`). Reduce-motion is respected by AnimatedNumber and the
 * decorative panel glows in modern-panels.
 */
export function EdgePlanV2HeroSummary({
  scenario,
  edgeAfterRewards,
  blendBreakdown,
  rawMathEdge,
  wagerScenario,
  onWagerScenarioChange,
  actions,
}: {
  /** The whole planning view at the active wager multiplier (1× = base projection). */
  scenario: WagerScenarioView;
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
  const profitAccent = houseAccent(scenario.profitDelta);
  const profitTextTone =
    profitAccent === "emerald" ? TEXT_TONE.emerald : TEXT_TONE.rose;
  const netTextTone = netEdgeTextTone(edgeAfterRewards.netEdgeAfterRewards);

  const activePresetMult =
    Number.isFinite(wagerScenario.presetMult) && wagerScenario.presetMult > 0
      ? wagerScenario.presetMult
      : 1;
  const scenarioActive = scenario.active;
  const wagerMultLabel = scenario.multLabel;
  /** "· at 2× wager" suffix for scenario-affected tile sublabels. */
  const atSuffix = scenarioActive ? ` · at ${wagerMultLabel} wager` : "";
  // Owner-excluded programs (spec #14, counts-toward-edge OFF) — feeds the
  // transparency footnote below the KPI strip. Empty at the all-on default,
  // so the footnote renders nothing and the hero is byte-identical to the
  // no-toggle layout (the identity contract).
  const excludedRows = scenario.levers.filter((l) => !l.includedInEdge);

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
          {scenarioActive && (
            <p className="mb-1.5 inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
              At {wagerMultLabel} wager — scenario
            </p>
          )}
          <p
            className={cn(
              "text-3xl font-bold leading-tight tracking-tight tabular-nums sm:text-4xl",
              profitTextTone,
            )}
          >
            <AnimatedNumber
              value={scenario.profitDelta}
              format="currency"
              duration={700}
            />
          </p>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
            In plain words: how much more (or less) the house keeps if this
            plan goes live, vs today&apos;s settings
            {scenarioActive
              ? ` — both sides at the ${wagerMultLabel} wager scenario.`
              : "."}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatSignedUsd(scenario.monthlyProfitDelta)}/mo ·{" "}
            {formatSignedUsd(scenario.annualProfitDelta)}/yr extrapolated
            {atSuffix}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 border-t pt-3">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Current NGR{scenarioActive ? ` · at ${wagerMultLabel}` : ""}
              </p>
              <p className="truncate font-semibold tabular-nums">
                {formatCompactUsd(scenario.currentNgr)}
              </p>
            </div>
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                Planned NGR{scenarioActive ? ` · at ${wagerMultLabel}` : ""}
              </p>
              <p
                className={cn(
                  "truncate font-semibold tabular-nums",
                  profitTextTone,
                )}
              >
                {formatCompactUsd(scenario.plannedNgr)}
              </p>
            </div>
          </div>
        </StatPanel>

        {/* ── Single gross -> net edge waterfall ───────────────────── */}
        <StatPanel title="Edge before & after rewards" icon={Percent} accent="cyan">
          <p className="mb-2 text-[11px] leading-snug text-muted-foreground">
            In plain words: Edge = % of every bet we keep. Reward drag = how
            much of the edge the rewards eat — left is the edge before
            rewards, right is what&apos;s left after.
          </p>
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
                  {/* Spec #7: 3-decimal precision — "10.495%" at defaults. */}
                  Raw math edge {formatRawMathEdgePctV2(rawMathEdge)}
                  <span className="font-normal text-muted-foreground/70">
                    · simple average of the two sliders, no volumes
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
              <span className="text-[10px] text-muted-foreground">
                reward drag{scenarioActive ? ` at ${wagerMultLabel}` : ""}
              </span>
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
              Scenario semantics (page-wide): fixed-window rewards (deposit
              bonus, races, raffles, daily packs, signup, rain, motha, gift
              cards, promo codes) hold planned $ for the window — their drag
              dilutes at higher wager. Rakeback, affiliate commission and
              shards scale $ with wager; deposit-fee revenue stays flat
              (deposits ≠ wager). Affiliate worst-case tier drag stays % of
              edge.
            </p>
          )}
        </StatPanel>
      </div>

      {/* ── Trimmed 6-tile KPI strip (string values only) ──────────── */}
      <div className="space-y-2">
        {scenarioActive && (
          <p className="text-[10px] font-semibold leading-snug text-amber-600 dark:text-amber-400">
            Scenario active: every tile marked &quot;at {wagerMultLabel}{" "}
            wager&quot; assumes customers bet {wagerMultLabel} the window
            volume — proportional rewards scale with it, fixed-window $
            budgets and deposit-fee revenue stay flat.
          </p>
        )}
        <p className="text-[10px] leading-snug text-muted-foreground">
          In plain words: Wager = how much customers bet · GGR = bets minus
          what players won back · NGR = GGR minus what we give away · Edge =
          % of every bet we keep · Reward drag = how much of the edge the
          rewards eat.
        </p>
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
          sub={`−${formatPct(edgeAfterRewards.plannedRewardDrag)} drag${atSuffix}`}
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
          label="Wager (30d, GGR model)"
          value={formatCompactUsd(scenario.wager)}
          sub={
            scenarioActive
              ? `at ${wagerMultLabel} wager · borrow excluded — owner strip above is lifetime (its 30d row is this window)`
              : "Planning base · borrow excluded — owner strip above is lifetime (its 30d row is this window)"
          }
          icon={Coins}
          accent="blue"
        />
        <KpiTile
          label="Planned GGR"
          value={formatCompactUsd(scenario.plannedGgr)}
          sub={`${formatPct(blendBreakdown.allWagerBlendedEdge)} all wager${atSuffix}`}
          icon={TrendingUp}
          accent="emerald"
        />
        <KpiTile
          label="Reward cost"
          value={formatCompactUsd(scenario.plannedRewardCost)}
          sub={`${formatSignedUsd(scenario.rewardCostDelta)}${atSuffix}`}
          icon={Wallet}
          accent="rose"
        />
        <KpiTile
          label="Planned NGR"
          value={formatCompactUsd(scenario.plannedNgr)}
          sub={`${formatSignedUsd(scenario.profitDelta)} vs current${atSuffix}`}
          icon={scenario.profitDelta >= 0 ? Gauge : TrendingDown}
          accent={houseAccent(scenario.profitDelta) === "emerald" ? "cyan" : "rose"}
        />
        </div>

        {/* ── Transparency footnote — owner-excluded programs (spec #14,
               creator-costs-footnote pattern). Lists every program whose
               counts-toward-edge toggle is OFF + its planned window $:
               still real spend (displayed in its box), but in NONE of the
               drag / reward-cost / after-rewards-edge / planned-NGR figures
               above. Hidden at the all-on default. ── */}
        {excludedRows.length > 0 && (
          <p className="border-t pt-2 text-[10px] leading-snug text-muted-foreground">
            Owner-excluded from edge attribution (counts-toward-edge OFF):{" "}
            {excludedRows.map((l, i) => (
              <React.Fragment key={l.key}>
                {i > 0 && " · "}
                <span className="font-medium text-foreground">{l.label}</span>{" "}
                <span className="tabular-nums">
                  {formatCurrency(l.plannedCost)}
                </span>
              </React.Fragment>
            ))}{" "}
            — planned window ${scenarioActive ? ` at ${wagerMultLabel} wager` : ""};
            still real spend (shown in its box, greyed chip), but in none of
            the drag / reward-cost / after-rewards-edge / planned-NGR figures
            above. Attribution control, not a $0 budget.
          </p>
        )}
      </div>
    </div>
  );
}
