"use client";

import { Percent, RefreshCw, Target } from "lucide-react";

import { PanelRow, SectionHeading } from "@/components/modern-panels";
import { formatCompactUsd } from "@/lib/utils/format";
import { formatPct } from "../../../edge-calc/math";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import {
  REWARD_WAGER_SOURCE_IDS,
  REWARD_WAGER_SOURCE_LABELS,
  type RewardWagerSourceId,
  rakebackEffectiveWagerMult,
  upgraderMinMultiplierEligibleShare,
  clamp,
  type EdgePlanV2Baseline,
  type PlannedLeversV2,
} from "../../_model-v2";

export function RakebackWagerControls({
  baseline,
  levers,
  setLevers,
}: {
  baseline: EdgePlanV2Baseline;
  levers: PlannedLeversV2;
  setLevers: React.Dispatch<React.SetStateAction<PlannedLeversV2>>;
}) {
  const disabled = baseline.rakebackCost <= 0;
  const upgrader = baseline.gameTypes.find((g) => g.type === "upgrader");
  const packs = baseline.gameTypes.find((g) => g.type === "packs");
  const battles = baseline.gameTypes.find((g) => g.type === "battles");
  const effective = rakebackEffectiveWagerMult(baseline, levers);
  const upgEligibleAtMin = upgraderMinMultiplierEligibleShare(
    baseline.upgraderRakebackAnchor,
    levers.rakebackUpgraderMinMultiplier,
  );

  const setRewardWeight = (id: RewardWagerSourceId) => (pct: number) =>
    setLevers((s) => ({
      ...s,
      rakebackRewardWagerWeights: {
        ...s.rakebackRewardWagerWeights,
        [id]: clamp(pct / 100, 0, 1),
      },
    }));

  const recycledShare = REWARD_WAGER_SOURCE_IDS.reduce(
    (sum, id) => sum + (baseline.rewardWagerShare[id] ?? 0),
    0,
  );

  return (
    <>
      <div className="mt-4 space-y-3 border-t pt-3">
        <SectionHeading icon={Percent} title="Wager → rakeback weight" />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          How much of each game&apos;s wager accrues rakeback. Example: 50% on
          upgrader means a $100 upgrader bet earns rakeback on $50 only.
        </p>
        <div className="mb-2 rounded-lg border bg-muted/15 px-2.5 py-2 text-[11px] text-muted-foreground">
          Effective accrual multiplier:{" "}
          <span className="font-semibold tabular-nums text-foreground">
            {(effective.combined * 100).toFixed(1)}%
          </span>{" "}
          of raw wager (game weights × reward recycling).
        </div>
        <LeverSlider
          label="Packs wager → rakeback"
          valueLabel={formatPct(levers.rakebackPacksWeight)}
          value={levers.rakebackPacksWeight * 100}
          onValueChange={(pct) =>
            setLevers((s) => ({
              ...s,
              rakebackPacksWeight: clamp(pct / 100, 0, 1),
            }))
          }
          min={0}
          max={100}
          step={0.1}
          baselineMarker={100}
          baselineLabel="current 100%"
          disabled={disabled || !(packs?.dataAvailable && (packs.wager ?? 0) > 0)}
          preciseInput={{ unit: "percent" }}
        />
        <LeverSlider
          label="Battles wager → rakeback"
          valueLabel={formatPct(levers.rakebackBattlesWeight)}
          value={levers.rakebackBattlesWeight * 100}
          onValueChange={(pct) =>
            setLevers((s) => ({
              ...s,
              rakebackBattlesWeight: clamp(pct / 100, 0, 1),
            }))
          }
          min={0}
          max={100}
          step={0.1}
          baselineMarker={100}
          baselineLabel="current 100%"
          disabled={disabled || !(battles?.dataAvailable && (battles.wager ?? 0) > 0)}
          preciseInput={{ unit: "percent" }}
        />
        <LeverSlider
          label="Upgrader wager → rakeback"
          valueLabel={formatPct(levers.rakebackUpgraderWeight)}
          value={levers.rakebackUpgraderWeight * 100}
          onValueChange={(pct) =>
            setLevers((s) => ({
              ...s,
              rakebackUpgraderWeight: clamp(pct / 100, 0, 1),
            }))
          }
          min={0}
          max={100}
          step={0.1}
          baselineMarker={100}
          baselineLabel="current 100%"
          disabled={disabled || !(upgrader?.dataAvailable && (upgrader.wager ?? 0) > 0)}
          preciseInput={{ unit: "percent" }}
        />
      </div>

      <div className="mt-4 space-y-3 border-t pt-3">
        <SectionHeading icon={Target} title="Upgrader eligibility" />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Filter which upgrader bets count — min target multiplier and cap on
          winning-bet accrual. Uses 30d multiplier bucket mix when available.
        </p>
        {baseline.upgraderRakebackAnchor && (
          <PanelRow
            label="Upgrader volume (30d)"
            value={formatCompactUsd(baseline.upgraderRakebackAnchor.totalWager)}
          />
        )}
        <LeverSlider
          label="Min target multiplier"
          valueLabel={`${levers.rakebackUpgraderMinMultiplier.toFixed(2)}×`}
          value={levers.rakebackUpgraderMinMultiplier * 100}
          onValueChange={(pct) =>
            setLevers((s) => ({
              ...s,
              rakebackUpgraderMinMultiplier: clamp(pct / 100, 1, 10),
            }))
          }
          min={100}
          max={1000}
          step={1}
          baselineMarker={100}
          baselineLabel={`${(upgEligibleAtMin * 100).toFixed(0)}% of upg. wager eligible`}
          disabled={disabled || !upgrader?.dataAvailable}
          preciseInput={{ unit: "multiplier" }}
        />
        <LeverSlider
          label="Max winning-bet accrual"
          valueLabel={formatPct(levers.rakebackUpgraderMaxWinPct)}
          value={levers.rakebackUpgraderMaxWinPct * 100}
          onValueChange={(pct) =>
            setLevers((s) => ({
              ...s,
              rakebackUpgraderMaxWinPct: clamp(pct / 100, 0, 1),
            }))
          }
          min={0}
          max={100}
          step={0.1}
          baselineMarker={100}
          baselineLabel={
            baseline.upgraderRakebackAnchor
              ? `hit rate ${(baseline.upgraderRakebackAnchor.winRate * 100).toFixed(0)}%`
              : "100% = full bet on wins"
          }
          disabled={disabled || !upgrader?.dataAvailable}
          preciseInput={{ unit: "percent" }}
        />
      </div>

      <div className="mt-4 space-y-3 border-t pt-3">
        <SectionHeading icon={RefreshCw} title="Reward-sourced wager recycling" />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          When balance came from rewards (race, rain, rakeback, etc.), how much
          of that wager earns rakeback again. 0% blocks double-dip; 100% is full
          recycle. Shares are estimated from 30d reward spend + borrow-play
          volume (~{(recycledShare * 100).toFixed(0)}% of wager modeled as
          reward-originated).
        </p>
        {REWARD_WAGER_SOURCE_IDS.map((id) => {
          const share = baseline.rewardWagerShare[id] ?? 0;
          return (
            <LeverSlider
              key={id}
              label={`${REWARD_WAGER_SOURCE_LABELS[id]} wager → rakeback`}
              valueLabel={formatPct(levers.rakebackRewardWagerWeights[id] ?? 1)}
              value={(levers.rakebackRewardWagerWeights[id] ?? 1) * 100}
              onValueChange={setRewardWeight(id)}
              min={0}
              max={100}
              step={0.1}
              baselineMarker={100}
              baselineLabel={
                share > 0
                  ? `~${(share * 100).toFixed(1)}% of ${formatCompactUsd(baseline.wager)} wager`
                  : "no modeled volume this window"
              }
              disabled={disabled}
              preciseInput={{ unit: "percent" }}
            />
          );
        })}
      </div>
    </>
  );
}
