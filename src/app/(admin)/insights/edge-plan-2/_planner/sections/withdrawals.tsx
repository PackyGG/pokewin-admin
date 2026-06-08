"use client";

import * as React from "react";
import { Banknote } from "lucide-react";

import { StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import { clamp, type EdgePlanV2Baseline, type PlannedLeversV2 } from "../../_model-v2";
import { multLabel } from "../utils";

export function WithdrawalsSection({
  baseline,
  levers,
  setLevers,
}: {
  baseline: EdgePlanV2Baseline;
  levers: PlannedLeversV2;
  setLevers: React.Dispatch<React.SetStateAction<PlannedLeversV2>>;
}) {
  return (
    <StatPanel title="Balance withdrawals & wager rules" icon={Banknote} accent="cyan">
      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
        Models the shift from item-only crypto withdrawals to balance cash-out. Wager
        requirement and per-game weights are what-if sliders — they do not write live
        Security config.
      </p>
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <PanelRow
          label="Est. withdrawal volume"
          value={formatCurrency(baseline.estimatedWithdrawalVolumeUsd)}
        />
        <LeverSlider
          label="Balance withdrawal share"
          valueLabel={`${(levers.balanceWithdrawalShare * 100).toFixed(0)}%`}
          value={levers.balanceWithdrawalShare * 100}
          onValueChange={(v) =>
            setLevers((s) => ({
              ...s,
              balanceWithdrawalShare: clamp(v / 100, 0, 1),
            }))
          }
          min={0}
          max={100}
          step={1}
          baselineMarker={baseline.balanceWithdrawalShare * 100}
        />
        <LeverSlider
          label="Wager requirement mult."
          valueLabel={multLabel(levers.withdrawalWagerReqMult)}
          value={levers.withdrawalWagerReqMult * 100}
          onValueChange={(v) =>
            setLevers((s) => ({
              ...s,
              withdrawalWagerReqMult: clamp(v / 100, 0, 5),
            }))
          }
          min={0}
          max={500}
          step={1}
          preciseInput={{ unit: "multiplier" }}
        />
        <LeverSlider
          label="Packs+battles wager weight"
          valueLabel={`${(levers.withdrawalPackBattleWeight * 100).toFixed(0)}%`}
          value={levers.withdrawalPackBattleWeight * 100}
          onValueChange={(v) =>
            setLevers((s) => ({
              ...s,
              withdrawalPackBattleWeight: clamp(v / 100, 0, 1),
            }))
          }
          min={0}
          max={100}
          step={1}
        />
        <LeverSlider
          label="Upgrader wager weight"
          valueLabel={`${(levers.withdrawalUpgraderWeight * 100).toFixed(0)}%`}
          value={levers.withdrawalUpgraderWeight * 100}
          onValueChange={(v) =>
            setLevers((s) => ({
              ...s,
              withdrawalUpgraderWeight: clamp(v / 100, 0, 1),
            }))
          }
          min={0}
          max={100}
          step={1}
        />
      </div>
    </StatPanel>
  );
}
