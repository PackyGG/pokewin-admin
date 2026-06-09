"use client";

import * as React from "react";
import { Banknote } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import {
  clamp,
  type EdgePlanV2Baseline,
  type EdgePlanV2Projection,
  type PlannedLeversV2,
} from "../../_model-v2";
import { multLabel } from "../utils";

/**
 * WithdrawalsSection — real-data display, no fabricated projection.
 *
 * The speculative withdrawal-friction ×0.25 P&L term was removed in the 2.0
 * rework (no real source), so there is no withdrawal lever row in the
 * projection and no invented adjustment number here. This section shows the
 * REAL 30d withdrawal volume + balance-vs-inventory split (sourced from the
 * ledger) and keeps the backend wager-requirement / per-game-weight knobs as
 * pure what-if sliders — they do not write live Security config and do not
 * produce a $ projection.
 */
export function WithdrawalsSection({
  baseline,
  levers,
  setLevers,
}: {
  baseline: EdgePlanV2Baseline;
  levers: PlannedLeversV2;
  /** Passed by the shell for a uniform section signature; no $ row uses it. */
  projection?: EdgePlanV2Projection;
  setLevers: React.Dispatch<React.SetStateAction<PlannedLeversV2>>;
}) {
  return (
    <StatPanel
      title="Balance withdrawals & wager rules"
      icon={Banknote}
      accent="cyan"
    >
      <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
        Real 30d withdrawal volume and the balance-vs-inventory split, shown as
        display context. Wager requirement and per-game weights are what-if
        sliders — they do not write live Security config and carry no $
        projection (the speculative friction adjustment was removed).
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
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
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
          baselineLabel="1× = current wager-requirement baseline"
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
