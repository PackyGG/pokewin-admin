"use client";

import * as React from "react";
import {
  CloudRain,
  Coins,
  Gift,
  Percent,
  Share2,
  ShieldCheck,
  Trophy,
  Wallet,
  Zap,
} from "lucide-react";

import { StatPanel, PanelRow, SectionHeading } from "@/components/modern-panels";
import { Switch } from "@/components/ui/switch";
import { formatCompactUsd, formatCurrency } from "@/lib/utils/format";
import { formatPct } from "../../../edge-calc/math";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import {
  REMOVE_WAGER_REQ_COST_UPLIFT,
  clamp,
  type EdgePlanV2Baseline,
  type PlannedLeversV2,
} from "../../_model-v2";
import { multLabel } from "../utils";
import { EmptyLever, formatPercentInt } from "../components/empty-lever";

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

  const matchPct = 100 * levers.depositBonusMatchMult;
  const capUsd = baseline.depositBonusCapUsd * levers.depositBonusCapMult;

  return (
    <div className="grid gap-4 xl:grid-cols-2 2xl:grid-cols-3">
      <StatPanel title="Rakeback" icon={Wallet} accent="rose">
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          Realized rakeback this window:{" "}
          <span className="font-medium text-rose-600 dark:text-rose-400">
            {formatCurrency(baseline.rakebackCost)}
          </span>
        </p>
        {baseline.rakebackCadences.length === 0 ? (
          <EmptyLever note="No rakeback cadences configured." />
        ) : (
          <>
            {baseline.rakebackCadences.map((c) => (
              <LeverSlider
                key={c.cadence}
                label={`${c.label}${c.enabled ? "" : " (disabled)"}`}
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
                max={Math.max(2, c.currentRate * 100 * 3)}
                step={0.001}
                baselineMarker={c.currentRate * 100}
                baselineLabel={`current ${formatPct(c.currentRate)}`}
                disabled={!c.enabled}
                preciseInput={{ unit: "percent", decimals: 3 }}
              />
            ))}

            <div className="mt-4 space-y-3 border-t pt-3">
              <SectionHeading icon={Percent} title="Wager weighting" />
              <LeverSlider
                label="Packs + battles wager → rakeback"
                valueLabel={formatPct(levers.rakebackPackBattleWeight)}
                value={levers.rakebackPackBattleWeight * 100}
                onValueChange={(pct) =>
                  setLevers((s) => ({
                    ...s,
                    rakebackPackBattleWeight: clamp(pct / 100, 0, 1),
                  }))
                }
                min={0}
                max={100}
                step={0.1}
                baselineMarker={100}
                baselineLabel="current 100%"
                disabled={baseline.rakebackCost <= 0}
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
                disabled={
                  baseline.rakebackCost <= 0 ||
                  !baseline.gameTypes.some(
                    (g) => g.type === "upgrader" && g.dataAvailable,
                  )
                }
                preciseInput={{ unit: "percent" }}
              />
            </div>

            <div className="mt-4 space-y-3 border-t pt-3">
              <SectionHeading icon={Zap} title="Instant claim" />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Planning what-if — instant payout % and adoption share trim realized
                rakeback cost.
              </p>
              <LeverSlider
                label="Instant payout %"
                valueLabel={formatPct(levers.rakebackInstantPayoutPct)}
                value={levers.rakebackInstantPayoutPct * 100}
                onValueChange={(pct) =>
                  setLevers((s) => ({
                    ...s,
                    rakebackInstantPayoutPct: clamp(pct / 100, 0, 1),
                  }))
                }
                min={0}
                max={100}
                step={0.1}
                baselineMarker={100}
                baselineLabel="100% = full accrual"
                disabled={baseline.rakebackCost <= 0}
                preciseInput={{ unit: "percent" }}
              />
              <LeverSlider
                label="Instant adoption"
                valueLabel={formatPct(levers.rakebackInstantAdoption)}
                value={levers.rakebackInstantAdoption * 100}
                onValueChange={(pct) =>
                  setLevers((s) => ({
                    ...s,
                    rakebackInstantAdoption: clamp(pct / 100, 0, 1),
                  }))
                }
                min={0}
                max={100}
                step={0.1}
                baselineMarker={0}
                baselineLabel="0% = nobody takes it"
                disabled={baseline.rakebackCost <= 0}
                preciseInput={{ unit: "percent" }}
              />
            </div>
          </>
        )}
      </StatPanel>

      <StatPanel title="Deposit bonus" icon={Coins} accent="amber">
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          Real config: {formatPercentInt(100)} match, cap{" "}
          {formatCurrency(baseline.depositBonusCapUsd)} per{" "}
          {baseline.depositBonusWindowHours}h. Realized spend:{" "}
          <span className="font-medium text-rose-600 dark:text-rose-400">
            {formatCurrency(baseline.depositBonusCost)}
          </span>
        </p>
        {baseline.depositBonusCost <= 0 ? (
          <EmptyLever note="No deposit-bonus spend in this window." />
        ) : (
          <div className="space-y-3">
            <LeverSlider
              label="Match %"
              valueLabel={formatPercentInt(matchPct)}
              value={levers.depositBonusMatchMult * 100}
              onValueChange={setMult("depositBonusMatchMult")}
              min={0}
              max={300}
              step={0.1}
              baselineMarker={100}
              preciseInput={{ unit: "multiplier" }}
            />
            <LeverSlider
              label="Cap $"
              valueLabel={formatCurrency(capUsd)}
              value={levers.depositBonusCapMult * 100}
              onValueChange={setMult("depositBonusCapMult")}
              min={0}
              max={300}
              step={0.1}
              baselineMarker={100}
              baselineLabel={`Real cap ${formatCurrency(baseline.depositBonusCapUsd)}`}
              preciseInput={{ unit: "multiplier" }}
            />
            <LeverSlider
              label="Min deposit gate"
              valueLabel={multLabel(levers.depositBonusMinDepositMult)}
              value={levers.depositBonusMinDepositMult * 100}
              onValueChange={setMult("depositBonusMinDepositMult")}
              min={0}
              max={300}
              step={0.1}
              baselineMarker={100}
              preciseInput={{ unit: "multiplier" }}
            />
            <LeverSlider
              label="Wager requirement"
              valueLabel={multLabel(levers.depositBonusWagerReqMult)}
              value={levers.depositBonusWagerReqMult * 100}
              onValueChange={setMult("depositBonusWagerReqMult")}
              min={0}
              max={300}
              step={0.1}
              baselineMarker={100}
              preciseInput={{ unit: "multiplier" }}
            />
          </div>
        )}
      </StatPanel>

      <StatPanel title="Races" icon={Trophy} accent="rose">
        <PanelRow label="Real race prize cost" value={formatCurrency(baseline.raceCost)} />
        {baseline.raceCost <= 0 ? (
          <EmptyLever note="No race prize cost in this window." />
        ) : (
          <>
            <LeverSlider label="Prize pool" valueLabel={multLabel(levers.racePrizePoolMult)} value={levers.racePrizePoolMult * 100} onValueChange={setMult("racePrizePoolMult")} min={0} max={300} step={1} baselineMarker={100} preciseInput={{ unit: "multiplier" }} />
            <LeverSlider label="Frequency" valueLabel={multLabel(levers.raceFrequencyMult)} value={levers.raceFrequencyMult * 100} onValueChange={setMult("raceFrequencyMult")} min={0} max={300} step={1} baselineMarker={100} preciseInput={{ unit: "multiplier" }} />
            <LeverSlider label="Entry cost" valueLabel={multLabel(levers.raceEntryCostMult)} value={levers.raceEntryCostMult * 100} onValueChange={setMult("raceEntryCostMult")} min={0} max={300} step={1} baselineMarker={100} preciseInput={{ unit: "multiplier" }} />
          </>
        )}
      </StatPanel>

      <StatPanel title="Rain" icon={CloudRain} accent="cyan">
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          Net house slice = max(0, rain wins − tips).
        </p>
        {baseline.rainWinTotal > 0 && (
          <div className="mb-3 space-y-0.5">
            <PanelRow
              label="Rain wins paid (gross)"
              value={
                <span className="text-rose-600 dark:text-rose-400">
                  {formatCompactUsd(baseline.rainWinTotal)}
                </span>
              }
            />
            <PanelRow
              label="− User / founder tips"
              value={
                <span className="text-emerald-600 dark:text-emerald-400">
                  {formatCompactUsd(baseline.rainTipTotal)}
                </span>
              }
            />
            <PanelRow
              label="= Net house slice"
              value={
                <span className="font-semibold text-rose-600 dark:text-rose-400">
                  {formatCompactUsd(baseline.rainCost)}
                </span>
              }
            />
          </div>
        )}
        {baseline.rainCost <= 0 ? (
          <EmptyLever
            note={
              baseline.rainWinTotal > 0
                ? "Tips fully covered rain wins this window."
                : "No net rain cost in this window."
            }
          />
        ) : (
          <LeverSlider
            label={`Net rain cost (real ${formatCompactUsd(baseline.rainCost)})`}
            valueLabel={formatCompactUsd(baseline.rainCost * Math.max(0, levers.rainCostMult))}
            value={levers.rainCostMult * 100}
            onValueChange={setMult("rainCostMult")}
            min={0}
            max={300}
            step={0.1}
            baselineMarker={100}
            preciseInput={{ unit: "multiplier" }}
          />
        )}
      </StatPanel>

      <div className="lg:col-span-2">
        <StatPanel title="Affiliate commission" icon={Share2} accent="rose">
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            Real affiliate cost:{" "}
            <span className="font-medium text-rose-600 dark:text-rose-400">
              {formatCurrency(baseline.affiliateCost)}
            </span>
            {baseline.affiliateBlendedRate != null && (
              <>
                {" "}
                · blended rate {formatPct(baseline.affiliateBlendedRate)}
              </>
            )}
          </p>
          {baseline.affiliateTiers.length === 0 ? (
            <EmptyLever note="No affiliate tiers configured." />
          ) : (
            <>
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
                  baselineMarker={t.currentRate * 100}
                  baselineLabel={`current ${formatPct(t.currentRate)}`}
                  preciseInput={{ unit: "percent", decimals: 2 }}
                />
              ))}
              <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <ShieldCheck className="size-3.5 text-muted-foreground" />
                    Remove 1× wager requirement
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    What-if only — models +{formatPct(REMOVE_WAGER_REQ_COST_UPLIFT)} cost
                    uplift when enabled.
                  </p>
                </div>
                <Switch
                  checked={levers.removeAffiliateWagerReq}
                  onCheckedChange={(v) =>
                    setLevers((s) => ({ ...s, removeAffiliateWagerReq: v }))
                  }
                />
              </div>
            </>
          )}
        </StatPanel>
      </div>

      <StatPanel title="Other & founder rewards" icon={Gift} accent="amber">
        {!baseline.otherRewardCost && !baseline.mothaCost ? (
          <EmptyLever note="No other reward cost or motha giveaways in this window." />
        ) : (
          <>
            <p className="mb-3 text-xs text-muted-foreground">
              Gift cards, promo codes, waitlist prizes, manual vouchers, and motha
              founder giveaways.
            </p>
            {baseline.otherRewardCost > 0 && (
              <LeverSlider
                label={`Other reward spend (real ${formatCompactUsd(baseline.otherRewardCost)})`}
                valueLabel={formatCompactUsd(
                  baseline.otherRewardCost * levers.otherRewardCostMult,
                )}
                value={levers.otherRewardCostMult * 100}
                onValueChange={setMult("otherRewardCostMult")}
                min={0}
                max={300}
                step={0.1}
                baselineMarker={100}
                preciseInput={{ unit: "multiplier" }}
              />
            )}
            {baseline.mothaCost > 0 && (
              <LeverSlider
                label={`Motha giveaways (real ${formatCompactUsd(baseline.mothaCost)})`}
                valueLabel={formatCompactUsd(baseline.mothaCost * levers.mothaCostMult)}
                value={levers.mothaCostMult * 100}
                onValueChange={setMult("mothaCostMult")}
                min={0}
                max={300}
                step={0.1}
                baselineMarker={100}
                preciseInput={{ unit: "multiplier" }}
              />
            )}
          </>
        )}
      </StatPanel>
    </div>
  );
}
