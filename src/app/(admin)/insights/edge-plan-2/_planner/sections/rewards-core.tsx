"use client";

import * as React from "react";
import { Clock, Coins, Share2, ShieldCheck, Wallet, Zap } from "lucide-react";

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
  affiliateGlobalScaleFactorV2,
  effectiveAffiliateRateV2,
  topAffiliateTierEdgeShare,
  computeTimeBonusEngineV2,
  depositBonusEligibilityRatio,
  eligibleDepositShare,
  isLeverIncludedInEdgeV2,
  resolveLeverSeedsV2,
  resolveLeverAnchorsV2,
  timeBonusSplitModel,
  type EdgePlanV2Baseline,
  type EdgePlanV2Projection,
  type PlannedLeversV2,
} from "../../_model-v2";
import { TEXT_TONE } from "../colors";
import { LeverGroup } from "../lever-group";
import { LeverHint } from "../components/lever-hint";
import { EmptyLever } from "../components/empty-lever";
import { PlannerBudgetInput } from "../components/usd-budget-input";
import { RakebackWagerControls } from "../components/rakeback-wager-controls";
import {
  EdgeInclusionToggle,
  InclusionAwareRewardTitle,
} from "../components/edge-inclusion-toggle";
import { leverEdgeDragPct } from "../components/reward-edge-drag";

/**
 * RewardsCoreSection — rakeback · deposit bonus · affiliate (v2.1 overhaul).
 *
 * Removed vs v2.0 (owner spec #5/#11): the deposit-bonus match-mult and
 * wager-req-mult sliders, the speculative hourly users/utilization pair, the
 * rakeback upgrader-eligibility cluster, and `removeAffiliateWagerReq`
 * (inverted into `affiliateWagerReqEnabled`, default ON = today). Races and
 * the founder/other panel moved to the Giveaways & budgets workspace.
 *
 * New here:
 *   • "Minimum deposit" DIRECT $ gate — eligibility share interpolated from
 *     the REAL 30d deposit-size histogram (cost ratio ≤ 1, monotone).
 *   • Grounded time-based bonus: the split-vs-lump model runs on the REAL
 *     per-user-day bonus histogram (`timeBonusAnchor`) — "N% of user-days
 *     hit the cap" + "$X/mo saved by splitting" readouts.
 *
 * The final eight (2026-06-12), surfaced in this section:
 *   • #8 — the time-based bonus block HEADLINES the deposit-bonus FORECAST
 *     ENGINE projection (`computeTimeBonusEngineV2`, same engine + same
 *     live-derived assumptions + same real-cost anchor as
 *     /insights/forecast?reward=deposit-bonus); the mechanical user-day-cap
 *     model stays only as a clearly-labeled secondary floor.
 *   • #9 — GLOBAL affiliate scale %: one input scaling ALL tier rates
 *     multiplicatively with the per-level sliders; each level row shows its
 *     effective rate live ("3.00% → 1.50%").
 *   • #14 — edge-inclusion toggles ("counts toward edge") in the title rows
 *     of rakeback / deposit bonus / affiliate. (The races box lives in the
 *     Giveaways & budgets section — its toggle is wired there.)
 */
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
    const edge = plannedHouseEdge > 0 ? plannedHouseEdge : observedHouseEdge;
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

  // Real affiliate split — commission = Σ|affiliate_claim|, leaderboard =
  // Σ|affiliate_leaderboard_prize| (fallback bundles the total as commission).
  const affiliateCommissionCost = Math.max(0, baseline.affiliateCommissionCost);
  const affiliateLeaderboardCost = Math.max(0, baseline.affiliateLeaderboardCost);

  // Resolved lever anchors — levers stay LIVE when a measured leg degraded
  // (the anchor falls back to a secondary measured source, flagged
  // `estimated`); the old `cost <= 0 → disabled` guards were the visible
  // half of the dead-planner bug.
  const anchors = React.useMemo(() => resolveLeverAnchorsV2(baseline), [baseline]);

  // ── Deposit bonus: $ gate + grounded time split ──
  const seeds = React.useMemo(
    () => resolveLeverSeedsV2(baseline, levers),
    [baseline, levers],
  );
  const observedMinDeposit = baseline.depositBonusMinDepositObservedUsd ?? 0;
  const eligibilityRatio = depositBonusEligibilityRatio(
    baseline,
    seeds.depositBonusMinDepositUsd,
  );
  const eligibleShare = eligibleDepositShare(
    baseline.depositSizeHistogram,
    Math.max(observedMinDeposit, seeds.depositBonusMinDepositUsd),
  );
  const split = timeBonusSplitModel(
    baseline.timeBonusAnchor,
    levers,
    baseline.periodDays,
  );
  const anchor = baseline.timeBonusAnchor;
  const depositBonusPlanned =
    projection.levers.find((l) => l.key === "deposit-bonus")?.plannedCost ??
    baseline.depositBonusCost;
  const capUsd = baseline.depositBonusCapUsd * levers.depositBonusCapMult;

  // #8 — the forecast-engine projection for the time-based bonus block.
  // Null = the `deposit-bonus-forecast` baseline leg degraded (or no real
  // bonus volume) → render only the labeled mechanical floor, loudly.
  const engine = React.useMemo(
    () => computeTimeBonusEngineV2(baseline, levers),
    [baseline, levers],
  );

  // #9 — the global affiliate scale factor (1 = neutral, hides the "→" UI).
  const affiliateScaleFactor = affiliateGlobalScaleFactorV2(levers);

  // #14 — per-program edge-inclusion (ON = today's attribution).
  const rakebackIncluded = isLeverIncludedInEdgeV2(levers, "rakeback");
  const depositBonusIncluded = isLeverIncludedInEdgeV2(levers, "deposit-bonus");
  const affiliateIncluded = isLeverIncludedInEdgeV2(levers, "affiliate");

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <div className="xl:col-span-2">
        <LeverGroup
          title={
            <InclusionAwareRewardTitle
              label="Rakeback"
              dragPct={leverEdgeDragPct(projection, "rakeback")}
              included={rakebackIncluded}
            />
          }
          icon={Wallet}
          accent="rose"
          action={
            <EdgeInclusionToggle
              leverKey="rakeback"
              levers={levers}
              setLevers={setLevers}
            />
          }
          headline={{
            label: "Realized this window",
            value: formatCurrency(baseline.rakebackCost),
            tone: "rose",
          }}
          intro={
            <>
              <p>
                In plain words: we hand players back a small slice of every
                bet they make — this is what that costs us.
              </p>
              <p className="mt-1">
                Direct rakeback cost = real config × real wager × game-type
                weighting. Cadence rates below are the primary lever; accrual
                weighting and instant-claim what-ifs are under Advanced.
              </p>
            </>
          }
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
                    Planning what-if — instant payout % and adoption share trim
                    realized rakeback cost.
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
                    disabled={anchors.rakeback.anchorUsd <= 0}
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
                    disabled={anchors.rakeback.anchorUsd <= 0}
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

      {/* ── Deposit bonus — cap mult + min-deposit $ gate + time split ────── */}
      <StatPanel
        title={
          <InclusionAwareRewardTitle
            label="Deposit bonus"
            dragPct={leverEdgeDragPct(projection, "deposit-bonus")}
            included={depositBonusIncluded}
          />
        }
        icon={Coins}
        accent="amber"
        action={
          <EdgeInclusionToggle
            leverKey="deposit-bonus"
            levers={levers}
            setLevers={setLevers}
          />
        }
      >
        <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
          In plain words: bonus money we add on top when players deposit.
        </p>
        <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
          Real config: cap {formatCurrency(baseline.depositBonusCapUsd)} per{" "}
          {baseline.depositBonusWindowHours}h. Realized spend:{" "}
          <span className={`font-medium ${TEXT_TONE.rose}`}>
            {formatCurrency(baseline.depositBonusCost)}
          </span>{" "}
          → planned{" "}
          <span className={`font-medium ${TEXT_TONE.rose}`}>
            {formatCurrency(depositBonusPlanned)}
          </span>
          .
        </p>
        {anchors.depositBonus.anchorUsd <= 0 ? (
          <EmptyLever note="No deposit-bonus spend in this window." />
        ) : (
          <div className="space-y-3">
            <LeverHint hint="Biggest bonus a single deposit can earn. Raising it only adds cost on large deposits that hit the cap.">
              <LeverSlider
                label="Cap $"
                valueLabel={formatCurrency(capUsd)}
                value={levers.depositBonusCapMult * 100}
                onValueChange={(pct) =>
                  setLevers((s) => ({
                    ...s,
                    depositBonusCapMult: clamp(pct / 100, 0, 5),
                  }))
                }
                min={0}
                max={300}
                step={0.1}
                baselineMarker={100}
                baselineLabel={`Real cap ${formatCurrency(baseline.depositBonusCapUsd)}`}
                preciseInput={{ unit: "multiplier" }}
              />
            </LeverHint>
            <div className="rounded-lg border bg-muted/15 px-3 py-2.5">
              <PlannerBudgetInput
                label="Minimum deposit"
                value={seeds.depositBonusMinDepositUsd}
                seeded={levers.depositBonusMinDepositUsd == null}
                onCommit={(next) =>
                  setLevers((s) => ({ ...s, depositBonusMinDepositUsd: next }))
                }
              />
              <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground/80">
                Smallest deposit that still earns the bonus — a direct $ gate.
                At {formatCurrency(Math.max(observedMinDeposit, seeds.depositBonusMinDepositUsd))}
                {" "}
                <span className="font-medium text-foreground">
                  {formatPct(eligibleShare, 1)}
                </span>{" "}
                of real 30d deposits stay eligible (cost ratio{" "}
                {formatPct(eligibilityRatio, 1)} — interpolated from the real
                deposit-size histogram; observed minimum{" "}
                {formatCurrency(observedMinDeposit)}).
              </p>
            </div>
          </div>
        )}
        <div className="mt-4 space-y-3 border-t pt-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Clock className="size-3.5 text-muted-foreground" />
              Time-based bonus (split vs lump)
            </div>
            <Switch
              checked={levers.depositBonusHourlyEnabled}
              onCheckedChange={(v) =>
                setLevers((s) => ({ ...s, depositBonusHourlyEnabled: v === true }))
              }
            />
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Pays the SAME bonus program as $X grants every N hours instead of
            a lump. The headline below is the deposit-bonus FORECAST ENGINE
            projection — the same engine, live-derived assumptions and
            real-cost anchor as /insights/forecast — with the mechanical
            user-day-cap model
            {anchor
              ? ` (${formatNumber(anchor.userDays)} user-days · ${formatNumber(
                  anchor.users,
                )} claimers · claim-rate ${formatPct(anchor.claimRatePerUserDay, 1)} of window days)`
              : " (no per-user-day anchor in this window)"}{" "}
            kept as a secondary floor: capping a user-day at amount × (24 ÷
            interval) can only trim cost — split ≤ lump, never more.
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
              <LeverHint hint="Hours between claims. $25 every 6h = a $100/day cap per user.">
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

              {/* #8 HEADLINE — the forecast-engine projection. */}
              {engine != null ? (
                <div className="space-y-0.5 rounded-lg border bg-muted/20 px-3 py-2.5">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Projected net savings
                    </span>
                    <span
                      className={`text-lg font-bold tabular-nums ${
                        engine.monthlyNetSavingsUsd > 0
                          ? TEXT_TONE.emerald
                          : engine.monthlyNetSavingsUsd < 0
                            ? TEXT_TONE.rose
                            : "text-muted-foreground"
                      }`}
                    >
                      {formatCurrency(engine.monthlyNetSavingsUsd)} / mo
                    </span>
                  </div>
                  <PanelRow
                    label="Gross savings (before retention loss)"
                    value={
                      <span
                        className={`tabular-nums ${
                          engine.monthlyGrossSavingsUsd > 0
                            ? TEXT_TONE.emerald
                            : "text-muted-foreground"
                        }`}
                      >
                        {formatCurrency(engine.monthlyGrossSavingsUsd)} / mo
                      </span>
                    }
                  />
                  <PanelRow
                    label={`Bonus cost (${engine.horizonDays}d) · current → split`}
                    value={
                      <span className={`tabular-nums ${TEXT_TONE.rose}`}>
                        {formatCurrency(engine.baselineCostUsd)} →{" "}
                        {formatCurrency(engine.scenarioCostUsd)}
                      </span>
                    }
                  />
                  <PanelRow
                    label="Scenario"
                    value={
                      engine.matchedLibraryScenario
                        ? `${engine.scenarioLabel} (${engine.scenarioId})`
                        : `${engine.scenarioLabel} (custom)`
                    }
                  />
                  <p className="pt-1 text-[10px] leading-snug text-muted-foreground/80">
                    Same engine as /insights/forecast?reward=deposit-bonus —
                    identical assumptions snapshot + real-cost anchor, so this
                    matches the forecast page&apos;s scenario row by
                    construction.
                  </p>
                </div>
              ) : (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
                  Forecast-engine headline unavailable — the
                  deposit-bonus-forecast baseline leg degraded this render (or
                  carries no real bonus volume). Only the mechanical
                  user-day-cap floor below is shown; reload to retry the
                  engine anchor.
                </div>
              )}

              {/* #8 SECONDARY FLOOR — the mechanical user-day-cap model. */}
              <div className="space-y-0.5 rounded-lg border bg-muted/20 px-3 py-2">
                <p className="pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Mechanical user-day-cap floor (secondary)
                </p>
                <PanelRow
                  label="Per-user daily cap"
                  value={formatCurrency(split.dailyCapUsd)}
                />
                <PanelRow
                  label="User-days that hit the cap"
                  value={formatPct(split.capHitUserDaysPct, 1)}
                />
                <PanelRow
                  label="Window cost · lump → split"
                  value={
                    <span className={`tabular-nums ${TEXT_TONE.rose}`}>
                      {formatCurrency(split.lumpWindowUsd)} →{" "}
                      {formatCurrency(split.splitWindowUsd)}
                    </span>
                  }
                />
                <PanelRow
                  label="Floor saved by splitting"
                  value={
                    <span
                      className={`font-semibold tabular-nums ${
                        split.savedMonthlyUsd > 0
                          ? TEXT_TONE.emerald
                          : "text-muted-foreground"
                      }`}
                    >
                      {formatCurrency(split.savedMonthlyUsd)} / mo
                    </span>
                  }
                />
              </div>
            </>
          )}
        </div>
      </StatPanel>

      {/* ── Affiliate commission ──────────────────────────────────────────── */}
      <StatPanel
        title={
          <InclusionAwareRewardTitle
            label="Affiliate commission"
            dragPct={leverEdgeDragPct(projection, "affiliate", affiliateDragCtx)}
            included={affiliateIncluded}
          />
        }
        icon={Share2}
        accent="rose"
        action={
          <EdgeInclusionToggle
            leverKey="affiliate"
            levers={levers}
            setLevers={setLevers}
          />
        }
      >
        <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
          In plain words: what we pay referrers for the players they bring —
          a share of the edge those players lose.
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
            {baseline.affiliateSplitSource === "ledger"
              ? "from the canonical ledger legs (customer scope — same as every other reward leg)."
              : "estimated — the ledger split reads failed, bundled total shown as commission."}
          </span>
        </p>
        {baseline.affiliateTiers.length === 0 ? (
          <EmptyLever note="No affiliate tiers configured." />
        ) : (
          <>
            <LeverHint hint="One % that scales ALL tier rates at once — 100% = current rates ($0 delta), 50% halves every level (L1 3.00% → 1.50%), 0% turns the program off. Multiplies the per-level sliders below.">
              <LeverSlider
                label="Global affiliate scale"
                valueLabel={`${formatPct(levers.affiliateGlobalScalePct / 100, 0)} of current rates`}
                value={levers.affiliateGlobalScalePct}
                onValueChange={(pct) =>
                  setLevers((s) => ({
                    ...s,
                    affiliateGlobalScalePct: clamp(pct, 0, 200),
                  }))
                }
                min={0}
                max={200}
                step={1}
                baselineMarker={100}
                baselineLabel="100% = current rates ($0 delta)"
                preciseInput={{ unit: "percent", decimals: 0 }}
              />
            </LeverHint>
            {baseline.affiliateTiers.map((t) => {
              const edgeShare = levers.affiliateRates[t.level] ?? t.currentRate;
              const effectiveShare = effectiveAffiliateRateV2(
                levers,
                t.level,
                t.currentRate,
              );
              const wagerDrag = affiliateEdgeShareToWagerDrag(
                effectiveShare,
                plannedHouseEdge,
              );
              return (
                <LeverSlider
                  key={t.level}
                  label={t.label}
                  valueLabel={
                    affiliateScaleFactor === 1
                      ? `${formatPct(edgeShare)} of edge (= ${formatPct(wagerDrag)} wager)`
                      : `${formatPct(edgeShare)} → ${formatPct(effectiveShare)} of edge (= ${formatPct(wagerDrag)} wager)`
                  }
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
                  Keep 1× wager requirement
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  ON = today (commission unlocks after a 1× wager). Turning it
                  OFF makes commission instantly withdrawable → ~+
                  {formatPct(removeWagerReqCommissionUplift())} commission cost
                  (the v1 breakage model — more referred GGR becomes payable;
                  tier rates unchanged).
                </p>
              </div>
              <Switch
                checked={levers.affiliateWagerReqEnabled}
                onCheckedChange={(v) =>
                  setLevers((s) => ({
                    ...s,
                    affiliateWagerReqEnabled: v === true,
                  }))
                }
              />
            </div>
          </>
        )}
      </StatPanel>
    </div>
  );
}
