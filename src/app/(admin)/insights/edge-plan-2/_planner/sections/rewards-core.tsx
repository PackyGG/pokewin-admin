"use client";

import * as React from "react";
import {
  Coins,
  Share2,
  ShieldCheck,
  Trophy,
  Wallet,
  Zap,
} from "lucide-react";

import { StatPanel, PanelRow, SectionHeading } from "@/components/modern-panels";
import { Switch } from "@/components/ui/switch";
import { formatCurrency } from "@/lib/utils/format";
import { formatPct } from "../../../edge-calc/math";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import {
  removeWagerReqCommissionUplift,
  clamp,
  plannedBlendedHouseEdgeV2,
  observedBlendedGamingEdge,
  affiliateEdgeShareToWagerDrag,
  affiliateWagerDragToEdgeShare,
  affiliateWorstCaseEdgeDrag,
  topAffiliateTierEdgeShare,
  type EdgePlanV2Baseline,
  type PlannedLeversV2,
} from "../../_model-v2";
import { multLabel } from "../utils";
import { TEXT_TONE } from "../colors";
import { LeverGroup } from "../lever-group";
import { EmptyLever, formatPercentInt } from "../components/empty-lever";
import { FounderOtherRewardsPanel } from "../components/founder-other-rewards-panel";
import { RakebackWagerControls } from "../components/rakeback-wager-controls";
import {
  leverEdgeDragPct,
  RewardPanelTitle,
} from "../components/reward-edge-drag";
import type { EdgePlanV2Projection } from "../../_model-v2";

export function RewardsCoreSection({
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
  const setMult = (key: keyof PlannedLeversV2) => (pct: number) =>
    setLevers((s) => ({ ...s, [key]: clamp(pct / 100, 0, 5) }));

  const plannedHouseEdge = React.useMemo(
    () => plannedBlendedHouseEdgeV2(baseline, levers),
    [baseline, levers],
  );

  const observedHouseEdge = React.useMemo(
    () => observedBlendedGamingEdge(baseline),
    [baseline],
  );

  const realizedAffiliateEdgeShare = React.useMemo(() => {
    if (baseline.affiliateBlendedRate == null) return null;
    const edge =
      plannedHouseEdge > 0 ? plannedHouseEdge : observedHouseEdge;
    return edge > 0
      ? affiliateWagerDragToEdgeShare(baseline.affiliateBlendedRate, edge)
      : null;
  }, [baseline.affiliateBlendedRate, observedHouseEdge, plannedHouseEdge]);

  const affiliateDragCtx = React.useMemo(
    () => ({ baseline, levers }),
    [baseline, levers],
  );

  const worstCaseAffiliateDrag = React.useMemo(
    () => affiliateWorstCaseEdgeDrag(baseline, levers),
    [baseline, levers],
  );

  const realizedAffiliateDrag = React.useMemo(() => {
    const wager = Math.max(0, projection.plannedWager || projection.currentWager);
    const lever = projection.levers.find((l) => l.key === "affiliate");
    return wager > 0 && lever ? lever.plannedCost / wager : 0;
  }, [projection]);

  const topTierEdgeShare = React.useMemo(
    () => topAffiliateTierEdgeShare(baseline, levers),
    [baseline, levers],
  );

  // Real affiliate split — sourced from getAffiliateOverview via the baseline
  // (commission = Σ|affiliate_claim|, leaderboard = Σ|affiliate_leaderboard_prize|).
  // Falls back to the bundled affiliateCost-as-commission only when the overview
  // query was null (affiliateSplitSource === "fallback").
  const affiliateCommissionCost = Math.max(0, baseline.affiliateCommissionCost);
  const affiliateLeaderboardCost = Math.max(0, baseline.affiliateLeaderboardCost);

  const matchPct = 100 * levers.depositBonusMatchMult;
  const capUsd = baseline.depositBonusCapUsd * levers.depositBonusCapMult;

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 2xl:grid-cols-3">
      <div className="xl:col-span-2 2xl:col-span-3">
      <LeverGroup
        title={<RewardPanelTitle label="Rakeback" dragPct={leverEdgeDragPct(projection, "rakeback")} />}
        icon={Wallet}
        accent="rose"
        headline={{
          label: "Realized this window",
          value: formatCurrency(baseline.rakebackCost),
          tone: "rose",
        }}
        intro="Direct rakeback cost = real config × real wager × game-type / upgrader weighting. Cadence rates below are the primary lever; accrual weighting and instant-claim what-ifs are under Advanced."
        advanced={
          baseline.rakebackCadences.length === 0 ? undefined : (
            <>
              <RakebackWagerControls
                baseline={baseline}
                levers={levers}
                setLevers={setLevers}
              />

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
          )
        }
        advancedLabel="Accrual weighting & instant claim"
      >
        {baseline.rakebackCadences.length === 0 ? (
          <EmptyLever note="No rakeback cadences configured." />
        ) : (
          baseline.rakebackCadences.map((c) => (
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
          ))
        )}
      </LeverGroup>
      </div>

      <StatPanel
        title={
          <RewardPanelTitle
            label="Deposit bonus"
            dragPct={leverEdgeDragPct(projection, "deposit-bonus")}
          />
        }
        icon={Coins}
        accent="amber"
      >
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          Real config: {formatPercentInt(100)} match, cap{" "}
          {formatCurrency(baseline.depositBonusCapUsd)} per{" "}
          {baseline.depositBonusWindowHours}h. Realized spend:{" "}
          <span className={`font-medium ${TEXT_TONE.rose}`}>
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

      <StatPanel
        title={<RewardPanelTitle label="Races" dragPct={leverEdgeDragPct(projection, "races")} />}
        icon={Trophy}
        accent="rose"
      >
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

      <FounderOtherRewardsPanel
        baseline={baseline}
        levers={levers}
        projection={projection}
        setLevers={setLevers}
      />

      <div className="lg:col-span-2">
        <StatPanel
          title={
            <RewardPanelTitle
              label="Affiliate commission"
              dragPct={leverEdgeDragPct(projection, "affiliate", affiliateDragCtx)}
            />
          }
          icon={Share2}
          accent="rose"
        >
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            Tier rates are a{" "}
            <span className="font-medium text-foreground">% of referred house edge</span>,
            not straight % of wager — worst-case planning drag (top tier only) = edge
            share × house edge (e.g. {formatPct(topTierEdgeShare)} of edge at{" "}
            {formatPct(plannedHouseEdge)} all-wager blended edge ={" "}
            <span className="font-medium text-foreground">
              {formatPct(worstCaseAffiliateDrag)} of wager
            </span>
            ). Realized commission spend:{" "}
            <span className={`font-medium ${TEXT_TONE.rose}`}>
              {formatCurrency(affiliateCommissionCost)}
            </span>
            {affiliateLeaderboardCost > 0 && (
              <>
                {" "}
                (+ {formatCurrency(affiliateLeaderboardCost)} leaderboard prizes)
              </>
            )}
            {baseline.affiliateBlendedRate != null && (
              <>
                {" "}
                · {formatPct(realizedAffiliateDrag)} of wager realized
                {realizedAffiliateEdgeShare != null && (
                  <> ({formatPct(realizedAffiliateEdgeShare)} of edge blended)</>
                )}
              </>
            )}
            .{" "}
            <span className="text-[11px] text-muted-foreground/80">
              Commission / leaderboard split{" "}
              {baseline.affiliateSplitSource === "overview"
                ? "from the affiliate overview (real ledger legs)."
                : "estimated — affiliate overview unavailable, bundled total shown as commission."}
            </span>
          </p>
          {baseline.affiliateTiers.length === 0 ? (
            <EmptyLever note="No affiliate tiers configured." />
          ) : (
            <>
              {baseline.affiliateTiers.map((t) => {
                const edgeShare = levers.affiliateRates[t.level] ?? t.currentRate;
                const wagerDrag = affiliateEdgeShareToWagerDrag(
                  edgeShare,
                  plannedHouseEdge,
                );
                return (
                <LeverSlider
                  key={t.level}
                  label={t.label}
                  valueLabel={`${formatPct(edgeShare)} of edge (= ${formatPct(wagerDrag)} wager)`}
                  value={edgeShare * 100}
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
                  baselineLabel={`current ${formatPct(t.currentRate)} of edge`}
                  preciseInput={{ unit: "percent", decimals: 2 }}
                />
              );
              })}
              <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border bg-muted/20 px-3 py-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <ShieldCheck className="size-3.5 text-muted-foreground" />
                    Remove 1× wager requirement
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    What-if only — removes the 35% referred-edge quality screen;
                    tier rates unchanged, ~+
                    {formatPct(removeWagerReqCommissionUplift())} affiliate
                    commission cost (more referred GGR becomes payable).
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
    </div>
  );
}
