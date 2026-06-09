"use client";

import * as React from "react";
import { Banknote } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import { clamp, type EdgePlanV2Baseline, type EdgePlanV2Projection, type PlannedLeversV2 } from "../../_model-v2";
import { multLabel } from "../utils";
import { leverEdgeDragPct, RewardPanelTitle } from "../components/reward-edge-drag";

export function WithdrawalsSection({
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
  return (
    <StatPanel
      title={
        <RewardPanelTitle
          label="Balance withdrawals & wager rules"
          dragPct={leverEdgeDragPct(projection, "withdrawals")}
        />
      }
      icon={Banknote}
      accent="cyan"
    >
      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
        Models balance cash-out vs inventory withdrawals. Wager requirement and
        per-game weights are what-if sliders — they do not write live Security
        config.
      </p>
      <div className="mb-4 flex flex-wrap gap-2">
        <Badge variant="outline" className="text-[10px]">
          Volume: {baseline.withdrawalVolumeSource === "ledger" ? "30d ledger" : "estimated"}
        </Badge>
        <Badge variant="outline" className="text-[10px]">
          Balance share:{" "}
          {baseline.balanceWithdrawalShareSource === "ledger" ? "30d ledger" : "estimated"}
        </Badge>
      </div>
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <PanelRow
          label="Withdrawal volume (30d)"
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
          baselineLabel={
            baseline.balanceWithdrawalShareSource === "ledger"
              ? "observed 30d split"
              : "planning default"
          }
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
          baselineMarker={100}
          baselineLabel="1× = current breakage baseline"
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
          baselineMarker={100}
          baselineLabel="100% = full weight"
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
          baselineMarker={100}
          baselineLabel="100% = full weight"
          disabled={
            !baseline.gameTypes.some(
              (g) => g.type === "upgrader" && g.dataAvailable,
            )
          }
        />
      </div>
    </StatPanel>
  );
}
