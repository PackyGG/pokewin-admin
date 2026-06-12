"use client";

import * as React from "react";
import { CloudRain, Crown, Gift, Trophy } from "lucide-react";

import { StatPanel, PanelRow } from "@/components/modern-panels";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  clamp,
  isLeverIncludedInEdgeV2,
  rainPlanV2,
  resolveLeverSeedsV2,
  type EdgeInclusionKey,
  type EdgePlanV2Baseline,
  type EdgePlanV2Projection,
  type PlannedLeversV2,
} from "../../_model-v2";
import { TEXT_TONE } from "../colors";
import { AdjustmentsPanel } from "../components/adjustments-panel";
import {
  EdgeInclusionToggle,
  InclusionAwareRewardTitle,
} from "../components/edge-inclusion-toggle";
import { EmptyLever } from "../components/empty-lever";
import { PlannerBudgetInput } from "../components/usd-budget-input";
import {
  leverEdgeDragPct,
  RewardPanelTitle,
} from "../components/reward-edge-drag";
import { RaffleKeepPanel } from "./raffles";

/**
 * GiveawaysSection — the "Giveaways & budgets" workspace (2026-06-12
 * overhaul + the final-eight specs). Every ×-multiplier cluster is replaced
 * by DIRECT inputs seeded from real 30d run-rates (`null` lever = run-rate
 * seed → profitDelta $0 at mount):
 *
 *   • Raffles — the ONE keep-slider panel (sections/raffles.tsx) + live
 *     raffle context cards + the lifetime history (spec #10).
 *   • Races — ONE monthly $ budget.
 *   • Rain — RAIN DURATION (spec #11): rains run BACK-TO-BACK, so the lever
 *     is the duration of one rain — rainsPerDay = 24 ÷ duration (set 2h →
 *     12 rains a day), monthly = rainsPerDay × 30 × $ per rain. Window cost
 *     still scales the canonical net rain cost by the planned ÷ observed
 *     pool-$ ratio (ratio 1 at the observed seeds → $0 delta).
 *   • Motha founder giveaways — ONE monthly $ budget + the real channel
 *     split readout.
 *   • Gift cards / promo codes — separate monthly $ budgets (real ledger
 *     legs); the residual "other" stays read-only.
 *   • Balance adjustments — real per-category 30d breakdown incl. the
 *     expandable NULL "Not itemized" drill-down (spec #12,
 *     components/adjustments-panel.tsx).
 *
 * Spec #14: every program box's title row carries a "counts toward edge"
 * switch (races, rain, motha — and the shared Other-rewards box carries one
 * per program: gift cards + promo codes; the residual "other" row is not a
 * program and stays always-attributed). OFF = excluded from drag/cost/edge/
 * NGR attribution while the $ keeps displaying.
 *
 * House-POV: every planned giveaway $ is house pays → rose.
 */
export function GiveawaysSection({
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
  const seeds = React.useMemo(
    () => resolveLeverSeedsV2(baseline, levers),
    [baseline, levers],
  );

  const plannedCost = (key: string): number =>
    projection.levers.find((l) => l.key === key)?.plannedCost ?? 0;

  // ── Rain duration plan (spec #11) — the model's labeled readout ──────────
  const anchor = baseline.rainAnchor;
  const rainPlan = React.useMemo(
    () => rainPlanV2(baseline, levers),
    [baseline, levers],
  );

  // ── Other-rewards combined chip: only the INCLUDED programs attribute ────
  const giftCardsIncluded = isLeverIncludedInEdgeV2(levers, "gift-cards");
  const promoCodesIncluded = isLeverIncludedInEdgeV2(levers, "promo-codes");
  const otherIncludedDrag =
    (giftCardsIncluded ? leverEdgeDragPct(projection, "gift-cards") : 0) +
    (promoCodesIncluded ? leverEdgeDragPct(projection, "promo-codes") : 0) +
    leverEdgeDragPct(projection, "other");

  return (
    <div className="space-y-4">
      {/* ── Raffles (keep-slider + live cards + lifetime history) ─────────── */}
      <RaffleKeepPanel
        baseline={baseline}
        levers={levers}
        projection={projection}
        setLevers={setLevers}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* ── Races — ONE monthly $ budget ────────────────────────────────── */}
        <StatPanel
          title={
            <InclusionAwareRewardTitle
              label="Races"
              dragPct={leverEdgeDragPct(projection, "races")}
              included={isLeverIncludedInEdgeV2(levers, "races")}
            />
          }
          icon={Trophy}
          accent="rose"
          action={
            <EdgeInclusionToggle
              leverKey="races"
              levers={levers}
              setLevers={setLevers}
            />
          }
        >
          <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
            In plain words: prize money for the wager races we run.
          </p>
          <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
            One monthly prize budget — seeded from the real 30d run-rate.
            Clear the box to drop back to the run-rate seed.
          </p>
          <PanelRow
            label="Real race prize cost (window)"
            value={formatCurrency(baseline.raceCost)}
            valueClassName={TEXT_TONE.rose}
          />
          <PanelRow
            label="Planned race cost (window)"
            value={formatCurrency(plannedCost("races"))}
            valueClassName={TEXT_TONE.rose}
          />
          <div className="mt-3 border-t pt-3">
            <PlannerBudgetInput
              label="Races monthly budget"
              value={seeds.raceMonthlyBudgetUsd}
              seeded={levers.raceMonthlyBudgetUsd == null}
              onCommit={(next) =>
                setLevers((s) => ({ ...s, raceMonthlyBudgetUsd: next }))
              }
            />
          </div>
        </StatPanel>

        {/* ── Rain — DURATION lever (spec #11), real `rains` anchor ───────── */}
        <StatPanel
          title={
            <InclusionAwareRewardTitle
              label="Rain"
              dragPct={leverEdgeDragPct(projection, "rain")}
              included={isLeverIncludedInEdgeV2(levers, "rain")}
            />
          }
          icon={CloudRain}
          accent="cyan"
          action={
            <EdgeInclusionToggle
              leverKey="rain"
              levers={levers}
              setLevers={setLevers}
            />
          }
        >
          <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
            In plain words: free money we drop into chat for everyone to
            grab. Rains run <strong>back-to-back</strong> — the lever is how
            long one rain lasts, so a shorter duration means MORE rains: set
            2h → 12 rains a day.
          </p>
          {anchor == null || anchor.count <= 0 ? (
            <EmptyLever note="No completed rains found in the window (or the scan failed) — the rain cost stays at its canonical baseline value." />
          ) : (
            <>
              <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
                Real 30d anchor: {formatNumber(anchor.count)} rains ·{" "}
                {formatCurrency(anchor.avgPoolUsd)} avg pool · observed
                back-to-back duration ≈{anchor.avgIntervalHours.toFixed(2)}h
                (the duration seed). Cost scales the canonical net rain cost
                (max(0, wins − tips)) by the planned ÷ observed pool-$ ratio
                — at the seeds the ratio is 1 → $0 delta.
              </p>
              <div className="space-y-2">
                <PlannerBudgetInput
                  label="Rain duration (hours)"
                  value={rainPlan.durationHours}
                  seeded={levers.rainDurationHours == null}
                  suffix="h"
                  min={0.05}
                  max={720}
                  decimals={2}
                  onCommit={(next) =>
                    setLevers((s) => ({
                      ...s,
                      rainDurationHours:
                        next == null ? null : clamp(next, 0.05, 720),
                    }))
                  }
                />
                <PlannerBudgetInput
                  label="Pool $ per rain"
                  value={rainPlan.perEventUsd}
                  seeded={levers.rainPerEventUsd == null}
                  onCommit={(next) =>
                    setLevers((s) => ({ ...s, rainPerEventUsd: next }))
                  }
                />
              </div>
              <div className="mt-3 space-y-0.5 border-t pt-3">
                <PanelRow
                  label="Rains per day (24h ÷ duration)"
                  value={`${trimHours(rainPlan.rainsPerDay)} / day`}
                />
                <PanelRow
                  label="Planned monthly rain budget"
                  value={formatCurrency(rainPlan.monthlyBudgetUsd)}
                  valueClassName={TEXT_TONE.rose}
                />
                <PanelRow
                  label="Observed pool $ (window)"
                  value={formatCurrency(rainPlan.observedWindowUsd)}
                />
                <PanelRow
                  label="Planned pool $ (window)"
                  value={formatCurrency(rainPlan.windowPlannedUsd)}
                />
                <PanelRow
                  label="Planned net rain cost (window)"
                  value={formatCurrency(plannedCost("rain"))}
                  valueClassName={TEXT_TONE.rose}
                />
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                In plain words: set {trimHours(rainPlan.durationHours)}h →{" "}
                {trimHours(rainPlan.rainsPerDay)} rains a day →{" "}
                {formatCurrency(rainPlan.monthlyBudgetUsd)} a month at{" "}
                {formatCurrency(rainPlan.perEventUsd)} per rain.
              </p>
            </>
          )}
        </StatPanel>

        {/* ── Motha founder giveaways — ONE monthly $ budget ──────────────── */}
        <StatPanel
          title={
            <InclusionAwareRewardTitle
              label="Motha giveaways"
              dragPct={leverEdgeDragPct(projection, "motha")}
              included={isLeverIncludedInEdgeV2(levers, "motha")}
            />
          }
          icon={Crown}
          accent="purple"
          action={
            <EdgeInclusionToggle
              leverKey="motha"
              levers={levers}
              setLevers={setLevers}
            />
          }
        >
          <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
            In plain words: giveaways funded from the founder&apos;s own
            account.
          </p>
          <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
            Founder giveaways (tips · rain · sponsorships) — one monthly
            budget against the real 30d run-rate.
          </p>
          <PanelRow
            label="Real motha cost (window)"
            value={formatCurrency(baseline.mothaCost)}
            valueClassName={TEXT_TONE.rose}
          />
          {baseline.mothaBreakdown && (
            <PanelRow
              label="Channel split (window)"
              value={
                <span className="text-xs tabular-nums text-muted-foreground">
                  tips {formatCurrency(baseline.mothaBreakdown.tips)} · rain{" "}
                  {formatCurrency(baseline.mothaBreakdown.rain)} · sponsor{" "}
                  {formatCurrency(baseline.mothaBreakdown.sponsorship)}
                </span>
              }
            />
          )}
          <PanelRow
            label="Planned motha cost (window)"
            value={formatCurrency(plannedCost("motha"))}
            valueClassName={TEXT_TONE.rose}
          />
          <div className="mt-3 border-t pt-3">
            <PlannerBudgetInput
              label="Motha monthly budget"
              value={seeds.mothaMonthlyBudgetUsd}
              seeded={levers.mothaMonthlyBudgetUsd == null}
              onCommit={(next) =>
                setLevers((s) => ({ ...s, mothaMonthlyBudgetUsd: next }))
              }
            />
          </div>
        </StatPanel>

        {/* ── Other rewards — gift cards + promo codes + residual ─────────── */}
        <StatPanel
          title={
            <RewardPanelTitle
              label="Other rewards"
              dragPct={otherIncludedDrag}
            />
          }
          icon={Gift}
          accent="amber"
          action={
            <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
              <MiniInclusionCluster
                programLabel="gift cards"
                leverKey="gift-cards"
                levers={levers}
                setLevers={setLevers}
              />
              <MiniInclusionCluster
                programLabel="promo codes"
                leverKey="promo-codes"
                levers={levers}
                setLevers={setLevers}
              />
            </span>
          }
        >
          <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">
            In plain words: gift cards, promo codes, and whatever smaller
            giveaways are left over.
          </p>
          <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
            Gift cards and promo codes are itemized from the real ledger legs
            and get their own monthly budgets — and their own
            counts-toward-edge switches in the title row; the residual
            &quot;other&quot; bucket stays read-only and always attributed.
          </p>
          <div className="space-y-2">
            <PlannerBudgetInput
              label="Gift cards monthly budget"
              value={seeds.giftCardsMonthlyUsd}
              seeded={levers.giftCardsMonthlyUsd == null}
              onCommit={(next) =>
                setLevers((s) => ({ ...s, giftCardsMonthlyUsd: next }))
              }
            />
            <PlannerBudgetInput
              label="Promo codes monthly budget"
              value={seeds.promoCodesMonthlyUsd}
              seeded={levers.promoCodesMonthlyUsd == null}
              onCommit={(next) =>
                setLevers((s) => ({ ...s, promoCodesMonthlyUsd: next }))
              }
            />
          </div>
          <div className="mt-3 space-y-0.5 border-t pt-3">
            <PanelRow
              label={`Gift cards (window real → planned)${
                giftCardsIncluded ? "" : " · excluded from edge"
              }`}
              value={
                <span className={`text-xs tabular-nums ${TEXT_TONE.rose}`}>
                  {formatCurrency(baseline.giftCardCost)} →{" "}
                  {formatCurrency(plannedCost("gift-cards"))}
                </span>
              }
            />
            <PanelRow
              label={`Promo codes (window real → planned)${
                promoCodesIncluded ? "" : " · excluded from edge"
              }`}
              value={
                <span className={`text-xs tabular-nums ${TEXT_TONE.rose}`}>
                  {formatCurrency(baseline.promoCodeCost)} →{" "}
                  {formatCurrency(plannedCost("promo-codes"))}
                </span>
              }
            />
            <PanelRow
              label="Residual other (read-only)"
              value={formatCurrency(plannedCost("other"))}
            />
          </div>
        </StatPanel>
      </div>

      {/* ── Balance adjustments — breakdown + drill-down + ONE $ input ────── */}
      <AdjustmentsPanel
        baseline={baseline}
        levers={levers}
        projection={projection}
        setLevers={setLevers}
      />
    </div>
  );
}

/** "2.00" → "2", "1.76" → "1.76" — trims trailing zeros for the plain-words copy. */
function trimHours(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return v
    .toFixed(2)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

/**
 * Compact per-program inclusion switch for boxes that hold TWO programs
 * (the shared Other-rewards box): tiny program label + the spec-#14 switch
 * in the panel's title-row action slot. Same lever mechanics as
 * `EdgeInclusionToggle`, just labeled per program so it is unambiguous
 * which switch belongs to which program.
 */
function MiniInclusionCluster({
  programLabel,
  leverKey,
  levers,
  setLevers,
}: {
  programLabel: string;
  leverKey: EdgeInclusionKey;
  levers: PlannedLeversV2;
  setLevers: React.Dispatch<React.SetStateAction<PlannedLeversV2>>;
}) {
  const included = isLeverIncludedInEdgeV2(levers, leverKey);
  return (
    <span
      className="flex shrink-0 items-center gap-1 normal-case tracking-normal"
      title={
        included
          ? `${programLabel}: counts toward edge — switch off to exclude it from edge/NGR attribution`
          : `${programLabel}: excluded from edge/NGR attribution — the $ stays displayed`
      }
    >
      <span
        className={cn(
          "text-[10px] font-medium",
          included
            ? "text-muted-foreground"
            : "text-amber-600 dark:text-amber-400",
        )}
      >
        {programLabel}
        {included ? "" : " · excluded"}
      </span>
      <Switch
        size="sm"
        checked={included}
        onCheckedChange={(v) =>
          setLevers((s) => ({
            ...s,
            edgeInclusion: { ...s.edgeInclusion, [leverKey]: v === true },
          }))
        }
        aria-label={`Counts toward edge — ${programLabel}`}
      />
    </span>
  );
}
