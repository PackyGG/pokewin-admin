"use client";

import * as React from "react";
import {
  CloudRain,
  Percent,
  Share2,
  Ticket,
  Trophy,
  Wallet,
} from "lucide-react";

import { StatPanel, PanelRow } from "@/components/modern-panels";
import { Switch } from "@/components/ui/switch";
import { formatCurrency } from "@/lib/utils/format";
import { formatPct } from "../../../edge-calc/math";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import {
  clamp,
  type EdgePlanV2Baseline,
  type PlannedLeversV2,
} from "../../_model-v2";
import { multLabel } from "../utils";

export function RewardsCoreSection({
  baseline,
  levers,
  setLevers,
}: {
  baseline: EdgePlanV2Baseline;
  levers: PlannedLeversV2;
  setLevers: React.Dispatch<React.SetStateAction<PlannedLeversV2>>;
}) {
  const setMult = (key: keyof PlannedLeversV2) => (pct: number) =>
    setLevers((s) => ({ ...s, [key]: clamp(pct / 100, 0, 5) }));

  return (
    <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
      <StatPanel title="Rakeback" icon={Wallet} accent="rose">
        {baseline.rakebackCadences.map((c) => (
          <LeverSlider
            key={c.cadence}
            label={c.label}
            valueLabel={formatPct(levers.rakebackRates[c.cadence] ?? c.currentRate)}
            value={(levers.rakebackRates[c.cadence] ?? c.currentRate) * 100}
            onValueChange={(pct) =>
              setLevers((s) => ({
                ...s,
                rakebackRates: {
                  ...s.rakebackRates,
                  [c.cadence]: clamp(pct / 100, 0, 1),
                },
              }))
            }
            min={0}
            max={100}
            step={0.01}
            disabled={!c.enabled}
            preciseInput={{ unit: "percent", decimals: 3 }}
          />
        ))}
      </StatPanel>

      <StatPanel title="Deposit bonus" icon={Percent} accent="rose">
        <LeverSlider label="Match %" valueLabel={multLabel(levers.depositBonusMatchMult)} value={levers.depositBonusMatchMult * 100} onValueChange={setMult("depositBonusMatchMult")} min={0} max={300} step={1} preciseInput={{ unit: "multiplier" }} />
        <LeverSlider label="Cap $" valueLabel={multLabel(levers.depositBonusCapMult)} value={levers.depositBonusCapMult * 100} onValueChange={setMult("depositBonusCapMult")} min={0} max={300} step={1} preciseInput={{ unit: "multiplier" }} />
        <LeverSlider label="Min deposit gate" valueLabel={multLabel(levers.depositBonusMinDepositMult)} value={levers.depositBonusMinDepositMult * 100} onValueChange={setMult("depositBonusMinDepositMult")} min={0} max={300} step={1} preciseInput={{ unit: "multiplier" }} />
        <LeverSlider label="Wager requirement" valueLabel={multLabel(levers.depositBonusWagerReqMult)} value={levers.depositBonusWagerReqMult * 100} onValueChange={setMult("depositBonusWagerReqMult")} min={0} max={300} step={1} preciseInput={{ unit: "multiplier" }} />
      </StatPanel>

      <StatPanel title="Races" icon={Trophy} accent="rose">
        <LeverSlider label="Prize pool" valueLabel={multLabel(levers.racePrizePoolMult)} value={levers.racePrizePoolMult * 100} onValueChange={setMult("racePrizePoolMult")} min={0} max={300} step={1} preciseInput={{ unit: "multiplier" }} />
        <LeverSlider label="Frequency" valueLabel={multLabel(levers.raceFrequencyMult)} value={levers.raceFrequencyMult * 100} onValueChange={setMult("raceFrequencyMult")} min={0} max={300} step={1} preciseInput={{ unit: "multiplier" }} />
        <LeverSlider label="Entry cost" valueLabel={multLabel(levers.raceEntryCostMult)} value={levers.raceEntryCostMult * 100} onValueChange={setMult("raceEntryCostMult")} min={0} max={300} step={1} preciseInput={{ unit: "multiplier" }} />
      </StatPanel>

      <StatPanel title="Rain" icon={CloudRain} accent="rose">
        <PanelRow label="Net rain (window)" value={formatCurrency(baseline.rainCost)} />
        <LeverSlider label="Rain cost mult." valueLabel={multLabel(levers.rainCostMult)} value={levers.rainCostMult * 100} onValueChange={setMult("rainCostMult")} min={0} max={300} step={1} preciseInput={{ unit: "multiplier" }} />
      </StatPanel>

      <StatPanel title="Affiliate" icon={Share2} accent="rose">
        {baseline.affiliateTiers.map((t) => (
          <LeverSlider
            key={t.level}
            label={t.label}
            valueLabel={formatPct(levers.affiliateRates[t.level] ?? t.currentRate)}
            value={(levers.affiliateRates[t.level] ?? t.currentRate) * 100}
            onValueChange={(pct) =>
              setLevers((s) => ({
                ...s,
                affiliateRates: {
                  ...s.affiliateRates,
                  [t.level]: clamp(pct / 100, 0, 1),
                },
              }))
            }
            min={0}
            max={100}
            step={0.01}
            preciseInput={{ unit: "percent", decimals: 2 }}
          />
        ))}
        <div className="mt-2 flex items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">Remove 1× wager req</span>
          <Switch
            checked={levers.removeAffiliateWagerReq}
            onCheckedChange={(v) =>
              setLevers((s) => ({ ...s, removeAffiliateWagerReq: v }))
            }
          />
        </div>
      </StatPanel>

      <StatPanel title="Other / motha" icon={Ticket} accent="amber">
        <LeverSlider label="Other reward cost" valueLabel={multLabel(levers.otherRewardCostMult)} value={levers.otherRewardCostMult * 100} onValueChange={setMult("otherRewardCostMult")} min={0} max={300} step={1} preciseInput={{ unit: "multiplier" }} />
        <LeverSlider label="Motha giveaways" valueLabel={multLabel(levers.mothaCostMult)} value={levers.mothaCostMult * 100} onValueChange={setMult("mothaCostMult")} min={0} max={300} step={1} preciseInput={{ unit: "multiplier" }} />
      </StatPanel>
    </div>
  );
}
