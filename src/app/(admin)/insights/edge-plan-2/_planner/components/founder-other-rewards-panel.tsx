"use client";

import { CloudRain, Gift } from "lucide-react";

import { StatPanel, PanelRow, SectionHeading } from "@/components/modern-panels";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import { clamp, type EdgePlanV2Baseline, type PlannedLeversV2 } from "../../_model-v2";
import type { EdgePlanV2Projection } from "../../_model-v2";
import { TEXT_TONE } from "../colors";
import { EmptyLever } from "./empty-lever";
import {
  combinedLeverEdgeDragPct,
  leverEdgeDragPct,
  RewardPanelTitle,
} from "./reward-edge-drag";

export function FounderOtherRewardsPanel({
  baseline,
  levers,
  projection,
  setLevers,
}: {
  baseline: EdgePlanV2Baseline;
  levers: PlannedLeversV2;
  projection: EdgePlanV2Projection;
  setLevers: React.Dispatch<React.SetStateAction<PlannedLeversV2>>;
}) {
  const setMult = (key: "rainCostMult" | "otherRewardCostMult" | "mothaCostMult") =>
    (pct: number) =>
      setLevers((s) => ({ ...s, [key]: clamp(pct / 100, 0, 5) }));

  const rainPlanned = baseline.rainCost * Math.max(0, levers.rainCostMult);
  const mothaPlanned = baseline.mothaCost * Math.max(0, levers.mothaCostMult);
  const otherPlanned =
    baseline.otherRewardCost * Math.max(0, levers.otherRewardCostMult);
  const combinedReal =
    baseline.rainCost + baseline.mothaCost + baseline.otherRewardCost;
  const combinedPlanned = rainPlanned + mothaPlanned + otherPlanned;

  const hasRainData = baseline.rainWinTotal > 0 || baseline.rainCost > 0;
  const hasMotha = baseline.mothaCost > 0;
  const hasOther = baseline.otherRewardCost > 0;
  const hasAnything = hasRainData || hasMotha || hasOther;

  return (
    <StatPanel
      title={
        <RewardPanelTitle
          label="Rain, founder & other rewards"
          dragPct={combinedLeverEdgeDragPct(projection, ["rain", "motha", "other"])}
        />
      }
      icon={Gift}
      accent="amber"
    >
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        Channels outside rakeback / affiliate / races — rain net slice, motha
        founder giveaways, and residual reward spend (gift cards, promos, vouchers).
      </p>

      {hasAnything ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              { label: "Rain (net)", value: baseline.rainCost, planned: rainPlanned },
              { label: "Motha", value: baseline.mothaCost, planned: mothaPlanned },
              { label: "Other", value: baseline.otherRewardCost, planned: otherPlanned },
              {
                label: "Combined",
                value: combinedReal,
                planned: combinedPlanned,
                emphasis: true,
              },
            ].map((tile) => (
              <div
                key={tile.label}
                className="rounded-lg border bg-background/40 px-2.5 py-2"
              >
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {tile.label}
                </p>
                <p
                  className={`text-sm font-semibold tabular-nums ${
                    tile.emphasis ? TEXT_TONE.rose : "text-foreground"
                  }`}
                >
                  {formatCompactUsd(tile.value)}
                </p>
                {tile.planned !== tile.value && (
                  <p className="text-[10px] tabular-nums text-muted-foreground">
                    → {formatCompactUsd(tile.planned)} planned
                  </p>
                )}
              </div>
            ))}
          </div>

          <div className="space-y-4">
            {hasRainData && (
              <div className="space-y-2 rounded-lg border bg-muted/15 p-3">
                <SectionHeading
                  icon={CloudRain}
                  title={
                    <RewardPanelTitle
                      label="Rain"
                      dragPct={leverEdgeDragPct(projection, "rain")}
                    />
                  }
                />
                {baseline.rainWinTotal > 0 && (
                  <div className="grid gap-0.5 text-sm">
                    <PanelRow
                      label="Wins paid (gross)"
                      value={
                        <span className={TEXT_TONE.rose}>
                          {formatCompactUsd(baseline.rainWinTotal)}
                        </span>
                      }
                    />
                    <PanelRow
                      label="− Tips (user + founder)"
                      value={
                        <span className={TEXT_TONE.emerald}>
                          {formatCompactUsd(baseline.rainTipTotal)}
                        </span>
                      }
                    />
                    <PanelRow
                      label="= Net house slice"
                      value={
                        <span className={`font-semibold ${TEXT_TONE.rose}`}>
                          {formatCompactUsd(baseline.rainCost)}
                        </span>
                      }
                    />
                  </div>
                )}
                {baseline.rainCost > 0 ? (
                  <LeverSlider
                    label="Rain intensity"
                    valueLabel={formatCompactUsd(rainPlanned)}
                    value={levers.rainCostMult * 100}
                    onValueChange={setMult("rainCostMult")}
                    min={0}
                    max={300}
                    step={0.1}
                    baselineMarker={100}
                    baselineLabel="Scales net house slice ($ × frequency proxy)"
                    preciseInput={{ unit: "multiplier" }}
                  />
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    Tips fully covered rain wins — no net house cost to scale.
                  </p>
                )}
              </div>
            )}

            {(hasMotha || baseline.mothaBreakdown) && (
              <div className="space-y-2 rounded-lg border bg-muted/15 p-3">
                <SectionHeading
                  icon={Gift}
                  title={
                    <RewardPanelTitle
                      label="Motha founder giveaways"
                      dragPct={leverEdgeDragPct(projection, "motha")}
                    />
                  }
                />
                {baseline.mothaBreakdown && (
                  <div className="grid gap-0.5 text-sm">
                    <PanelRow
                      label="Creator tips"
                      value={formatCompactUsd(baseline.mothaBreakdown.tips)}
                    />
                    <PanelRow
                      label="Rain tips (founder pool)"
                      value={formatCompactUsd(baseline.mothaBreakdown.rain)}
                    />
                    <PanelRow
                      label="Battle sponsorship"
                      value={formatCompactUsd(baseline.mothaBreakdown.sponsorship)}
                    />
                    <PanelRow
                      label="Active giveaway days"
                      value={baseline.mothaBreakdown.activeDays.toLocaleString()}
                    />
                  </div>
                )}
                {hasMotha ? (
                  <LeverSlider
                    label={`Motha budget (real ${formatCompactUsd(baseline.mothaCost)})`}
                    valueLabel={formatCompactUsd(mothaPlanned)}
                    value={levers.mothaCostMult * 100}
                    onValueChange={setMult("mothaCostMult")}
                    min={0}
                    max={300}
                    step={0.1}
                    baselineMarker={100}
                    baselineLabel="creator_tip · rain_tips · battle_sponsorship"
                    preciseInput={{ unit: "multiplier" }}
                  />
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    No motha outflow this window — channel split shown for context.
                  </p>
                )}
              </div>
            )}

            <div className="space-y-2 rounded-lg border bg-muted/15 p-3">
              <SectionHeading
                icon={Gift}
                title={
                  <RewardPanelTitle
                    label="Other reward spend"
                    dragPct={leverEdgeDragPct(projection, "other")}
                  />
                }
              />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                gift_card · promo_code · waitlist · manual vouchers · balance
                adjustments not itemized elsewhere.
              </p>
              {hasOther ? (
                <>
                  <PanelRow
                    label="Realized (window)"
                    value={
                      <span className={`font-semibold ${TEXT_TONE.rose}`}>
                        {formatCurrency(baseline.otherRewardCost)}
                      </span>
                    }
                  />
                  <LeverSlider
                    label="Other spend mult."
                    valueLabel={formatCompactUsd(otherPlanned)}
                    value={levers.otherRewardCostMult * 100}
                    onValueChange={setMult("otherRewardCostMult")}
                    min={0}
                    max={300}
                    step={0.1}
                    baselineMarker={100}
                    preciseInput={{ unit: "multiplier" }}
                  />
                </>
              ) : (
                <EmptyLever note="No other reward spend in this window." />
              )}
            </div>
          </div>
        </>
      ) : (
        <EmptyLever note="No rain, motha, or other reward cost in this window." />
      )}
    </StatPanel>
  );
}
