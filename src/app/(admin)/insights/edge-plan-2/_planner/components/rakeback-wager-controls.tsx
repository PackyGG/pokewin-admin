"use client";

import { Percent } from "lucide-react";

import { SectionHeading } from "@/components/modern-panels";
import { formatPct } from "../../../edge-calc/math";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import {
  rakebackEffectiveWagerMult,
  clamp,
  type EdgePlanV2Baseline,
  type PlannedLeversV2,
} from "../../_model-v2";

/**
 * Rakeback accrual-weight controls (Advanced cluster of the Rakeback group).
 *
 * v2.1 overhaul: the upgrader-eligibility cluster (min target multiplier +
 * max winning-bet accrual) was REMOVED with its levers
 * (`rakebackUpgraderMinMultiplier` / `rakebackUpgraderMaxWinPct` no longer
 * exist on `PlannedLeversV2`). What remains is the per-game accrual
 * weighting — how much of each game's wager earns rakeback.
 */
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

  return (
    <>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Rakeback returns a % of wager to players. The cadence rates (daily /
        weekly / monthly) set that %. The game weights below set how much of
        each game&apos;s wager earns rakeback (100% = all of it counts).
        Instant payout is a smaller immediate payout some users take instead
        of the full accrual — which lowers the cost.
      </p>
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
          of raw wager (volume-weighted game weights).
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
    </>
  );
}
