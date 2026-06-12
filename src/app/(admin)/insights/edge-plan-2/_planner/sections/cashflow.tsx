"use client";

import * as React from "react";
import { Banknote, Coins } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCurrency } from "@/lib/utils/format";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import {
  clamp,
  depositFeeRevenueUsd,
  type EdgePlanV2Baseline,
  type EdgePlanV2Projection,
  type PlannedLeversV2,
} from "../../_model-v2";
import { LeverHint } from "../components/lever-hint";
import { DepositFeeControls } from "../components/deposit-fee-controls";
import { WithdrawalExample } from "../components/withdrawal-example";

/**
 * CashflowSection — deposits & withdrawals.
 *
 *  1. Deposit fee (REVENUE lever, owner spec #4): fee % on the real 30d
 *     deposit volume of the SELECTED coins (chips from
 *     `baseline.depositsByAsset`; USDT* exempt by default). Revenue enters
 *     the projection as `+ revenueDelta` (profitDelta = ggrDelta −
 *     rewardCostDelta + revenueDelta) — NOT as a cost row — and is emerald
 *     (house income). It deliberately does NOT scale with the wager-scenario
 *     multiplier (deposits ≠ wager).
 *  2. Withdrawal wager rules (owner spec #12): per-gamemode weight inputs +
 *     a worked-example calculator. Display-only — no $ projection; the live
 *     wager-requirement setting stays in Security.
 *  3. The REAL 30d withdrawal volume + balance-vs-inventory split readout
 *     (migrated from the old withdrawals section; the speculative friction
 *     P&L term stays dead).
 */
export function CashflowSection({
  baseline,
  levers,
  setLevers,
}: {
  baseline: EdgePlanV2Baseline;
  levers: PlannedLeversV2;
  /** Passed by the shell for a uniform section signature. */
  projection?: EdgePlanV2Projection;
  setLevers: React.Dispatch<React.SetStateAction<PlannedLeversV2>>;
}) {
  const feeRevenueWindowUsd = depositFeeRevenueUsd(baseline, levers);
  const upgraderAvailable = baseline.gameTypes.some(
    (g) => g.type === "upgrader" && g.dataAvailable,
  );

  return (
    <div className="space-y-6">
      <StatPanel title="Deposit fee (revenue)" icon={Coins} accent="emerald">
        <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
          In plain words: a small cut we take on deposits of selected coins —
          house income, not a reward cost.
        </p>
        <p className="mb-4 text-[11px] leading-relaxed text-muted-foreground">
          A fee charged on deposits of the selected coins — a REVENUE channel,
          not a reward cost: it adds to profit as ggrDelta − rewardCostDelta +
          revenueDelta. Volumes are real 30-day completed deposits per coin;
          the USDT family is exempt by default.
        </p>
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <div className="space-y-4">
            <LeverHint hint="Fee taken from each deposit of a selected coin. 0% = today (no fee).">
              <LeverSlider
                label="Deposit fee"
                valueLabel={`${(levers.depositFeePct * 100).toFixed(2)}%`}
                value={levers.depositFeePct * 100}
                onValueChange={(v) =>
                  setLevers((s) => ({
                    ...s,
                    depositFeePct: clamp(v / 100, 0, 1),
                  }))
                }
                min={0}
                max={10}
                step={0.05}
                baselineMarker={0}
                baselineLabel="0% = current (no deposit fee)"
                preciseInput={{ unit: "percent", decimals: 2 }}
              />
            </LeverHint>
            <PanelRow
              label="Projected fee revenue (30d)"
              value={`+${formatCurrency(feeRevenueWindowUsd)}`}
              valueClassName="text-emerald-600 dark:text-emerald-400"
            />
            <p className="text-[11px] leading-snug text-muted-foreground/80">
              Fee revenue does NOT scale with the wager-scenario multiplier —
              deposits are not wager.
            </p>
          </div>
          <DepositFeeControls
            baseline={baseline}
            levers={levers}
            setLevers={setLevers}
          />
        </div>
      </StatPanel>

      <StatPanel
        title="Balance withdrawals & wager rules"
        icon={Banknote}
        accent="cyan"
      >
        <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
          In plain words: how much players must bet before they can withdraw
          — rules for players, not a house cost.
        </p>
        <p className="mb-4 text-[11px] leading-relaxed text-muted-foreground">
          Planning knobs only — these model withdrawal behavior (balance vs
          inventory split, per-game wager weights toward the unlock
          requirement) for context. They do NOT change any projected cost
          here; the real withdrawal wager-requirement setting lives in
          Security. The volume + split shown are real 30-day ledger data.
        </p>
        <div className="mb-4 flex flex-wrap gap-2">
          <Badge variant="outline" className="text-[10px]">
            Volume:{" "}
            {baseline.withdrawalVolumeSource === "ledger"
              ? "30d ledger"
              : "estimated"}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            Balance share:{" "}
            {baseline.balanceWithdrawalShareSource === "ledger"
              ? "30d ledger"
              : "estimated"}
          </Badge>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <PanelRow
            label="Withdrawal volume (30d)"
            value={formatCurrency(baseline.estimatedWithdrawalVolumeUsd)}
          />
          <LeverHint hint="Share of withdrawals drawn from cash balance vs cashed-out inventory. Ticks today's observed split.">
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
          </LeverHint>
          <LeverHint hint="How much pack + battle wager counts toward the unlock requirement. 100% = all of it.">
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
          </LeverHint>
          <LeverHint hint="How much upgrader wager counts toward the unlock requirement. 100% = all of it.">
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
              disabled={!upgraderAvailable}
            />
          </LeverHint>
        </div>
        <div className="mt-4">
          <WithdrawalExample
            packBattleWeight={levers.withdrawalPackBattleWeight}
            upgraderWeight={levers.withdrawalUpgraderWeight}
            upgraderAvailable={upgraderAvailable}
          />
        </div>
      </StatPanel>
    </div>
  );
}
