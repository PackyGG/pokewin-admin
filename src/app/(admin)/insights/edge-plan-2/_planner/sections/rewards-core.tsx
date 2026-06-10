"use client";

import * as React from "react";
import {
  Clock,
  Coins,
  Share2,
  ShieldCheck,
  Trophy,
  Wallet,
  Zap,
} from "lucide-react";

import { StatPanel, PanelRow, SectionHeading } from "@/components/modern-panels";
import { Switch } from "@/components/ui/switch";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
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
  depositBonusHourlyCostV2,
  type EdgePlanV2Baseline,
  type PlannedLeversV2,
} from "../../_model-v2";
import { multLabel } from "../utils";
import { TEXT_TONE } from "../colors";
import { LeverGroup } from "../lever-group";
import { LeverHint } from "../components/lever-hint";
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
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          Each lever is a ×multiplier on today&apos;s real setting — 1× = today, 2×
          = double. See the line under each one for what it does.
        </p>
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
            <LeverHint hint="Share of each deposit paid back as bonus. 1× = today's 100% match; 2× matches double.">
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
            </LeverHint>
            <LeverHint hint="Biggest bonus a single deposit can earn. Raising it only adds cost on large deposits that hit the cap.">
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
            </LeverHint>
            <LeverHint hint="Smallest deposit that qualifies for the bonus. Higher gate filters out small claimers → less cost.">
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
            </LeverHint>
            <LeverHint hint="How much must be wagered before the bonus unlocks. Higher = more bonuses expire unused → lower real cost.">
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
            </LeverHint>
          </div>
        )}
        <div className="mt-4 space-y-3 border-t pt-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Clock className="size-3.5 text-muted-foreground" />
              Time-based bonus (per user)
            </div>
            <Switch
              checked={levers.depositBonusHourlyEnabled}
              onCheckedChange={(v) =>
                setLevers((s) => ({ ...s, depositBonusHourlyEnabled: v }))
              }
            />
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            A fixed grant each user can claim on a clock (e.g. $25 every 6h). Cost
            = amount × (window ÷ interval) × users × utilization — a NEW planned
            cost on top of the match bonus above.
          </p>
          {levers.depositBonusHourlyEnabled && (
            <>
              <LeverHint hint="Dollars each user receives per claim (e.g. $25).">
                <LeverSlider
                  label="Amount per grant"
                  valueLabel={formatCurrency(levers.depositBonusHourlyAmountUsd)}
                  value={levers.depositBonusHourlyAmountUsd}
                  onValueChange={(v) =>
                    setLevers((s) => ({
                      ...s,
                      depositBonusHourlyAmountUsd: Math.max(0, v),
                    }))
                  }
                  min={0}
                  max={500}
                  step={1}
                  preciseInput={{ unit: "usd" }}
                />
              </LeverHint>
              <LeverHint hint="Hours between claims. $25 every 6h = 4 grants per user per day.">
                <LeverSlider
                  label="Every"
                  valueLabel={`${Math.round(levers.depositBonusHourlyIntervalHours)}h`}
                  value={levers.depositBonusHourlyIntervalHours}
                  onValueChange={(v) =>
                    setLevers((s) => ({
                      ...s,
                      depositBonusHourlyIntervalHours: clamp(v, 1, 720),
                    }))
                  }
                  min={1}
                  max={168}
                  step={1}
                />
              </LeverHint>
              <LeverHint hint="How many users claim it. Total cost scales straight with this count.">
                <LeverSlider
                  label="Participating users"
                  valueLabel={formatNumber(levers.depositBonusHourlyUsers)}
                  value={levers.depositBonusHourlyUsers}
                  onValueChange={(v) =>
                    setLevers((s) => ({
                      ...s,
                      depositBonusHourlyUsers: Math.max(0, Math.round(v)),
                    }))
                  }
                  min={0}
                  max={5000}
                  step={10}
                />
              </LeverHint>
              <LeverHint hint="Share of available grants actually claimed. 60% = users skip ~4 in 10.">
                <LeverSlider
                  label="Utilization"
                  valueLabel={formatPct(levers.depositBonusHourlyUtilizationPct)}
                  value={levers.depositBonusHourlyUtilizationPct * 100}
                  onValueChange={(v) =>
                    setLevers((s) => ({
                      ...s,
                      depositBonusHourlyUtilizationPct: clamp(v / 100, 0, 1),
                    }))
                  }
                  min={0}
                  max={100}
                  step={1}
                  preciseInput={{ unit: "percent" }}
                />
              </LeverHint>
              <div className="flex items-center justify-between rounded-lg border bg-muted/20 px-3 py-2 text-sm">
                <span className="text-muted-foreground">
                  Planned cost ({baseline.periodLabel})
                </span>
                <span className={`font-semibold tabular-nums ${TEXT_TONE.rose}`}>
                  {formatCurrency(depositBonusHourlyCostV2(baseline, levers))}
                </span>
              </div>
            </>
          )}
        </div>
      </StatPanel>

      <StatPanel
        title={<RewardPanelTitle label="Races" dragPct={leverEdgeDragPct(projection, "races")} />}
        icon={Trophy}
        accent="rose"
      >
        <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
          ×multipliers on the current real race program (1× = today). See the line
          under each lever for what it does.
        </p>
        <PanelRow label="Real race prize cost" value={formatCurrency(baseline.raceCost)} />
        {baseline.raceCost <= 0 ? (
          <EmptyLever note="No race prize cost in this window." />
        ) : (
          <div className="space-y-3">
            <LeverHint hint="Total prize money paid out. Cost scales straight with it.">
              <LeverSlider label="Prize pool" valueLabel={multLabel(levers.racePrizePoolMult)} value={levers.racePrizePoolMult * 100} onValueChange={setMult("racePrizePoolMult")} min={0} max={300} step={1} baselineMarker={100} preciseInput={{ unit: "multiplier" }} />
            </LeverHint>
            <LeverHint hint="How often races run. 2× ≈ twice as many races ≈ 2× the total prize cost.">
              <LeverSlider label="Frequency" valueLabel={multLabel(levers.raceFrequencyMult)} value={levers.raceFrequencyMult * 100} onValueChange={setMult("raceFrequencyMult")} min={0} max={300} step={1} baselineMarker={100} preciseInput={{ unit: "multiplier" }} />
            </LeverHint>
            <LeverHint hint="Ticket price to enter a race. Higher slightly deters farming → a touch less cost.">
              <LeverSlider label="Entry cost" valueLabel={multLabel(levers.raceEntryCostMult)} value={levers.raceEntryCostMult * 100} onValueChange={setMult("raceEntryCostMult")} min={0} max={300} step={1} baselineMarker={100} preciseInput={{ unit: "multiplier" }} />
            </LeverHint>
          </div>
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
          <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
            Affiliate commission is paid as a % of the house edge on referred
            players&apos; play (not their wager). The Remove-wager-requirement
            toggle drops a payout-quality screen — turning it on pays more
            affiliates (about +15% cost).
          </p>
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
