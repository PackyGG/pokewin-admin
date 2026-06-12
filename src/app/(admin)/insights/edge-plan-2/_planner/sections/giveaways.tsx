"use client";

import * as React from "react";
import { CloudRain, Crown, Gift, Trophy } from "lucide-react";

import { StatPanel, PanelRow } from "@/components/modern-panels";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import {
  clamp,
  resolveLeverSeedsV2,
  type EdgePlanV2Baseline,
  type EdgePlanV2Projection,
  type PlannedLeversV2,
} from "../../_model-v2";
import { TEXT_TONE } from "../colors";
import { AdjustmentsPanel } from "../components/adjustments-panel";
import { EmptyLever } from "../components/empty-lever";
import { PlannerBudgetInput } from "../components/usd-budget-input";
import {
  leverEdgeDragPct,
  RewardPanelTitle,
} from "../components/reward-edge-drag";
import { RaffleKeepPanel } from "./raffles";

/**
 * GiveawaysSection — the "Giveaways & budgets" workspace (2026-06-12
 * overhaul). Every ×-multiplier cluster is replaced by DIRECT inputs seeded
 * from real 30d run-rates (`null` lever = run-rate seed → profitDelta $0 at
 * mount):
 *
 *   • Raffles — the ONE keep-slider panel (sections/raffles.tsx) + live
 *     raffle context cards.
 *   • Races — ONE monthly $ budget.
 *   • Rain — cadence (hours between rains) + pool $ per rain, seeded from
 *     the real `rains` table anchor; cost scales the canonical net rain
 *     cost by the planned/observed monthly $ ratio.
 *   • Motha founder giveaways — ONE monthly $ budget + the real channel
 *     split readout.
 *   • Gift cards / promo codes — separate monthly $ budgets (real ledger
 *     legs); the residual "other" stays read-only.
 *   • Balance adjustments — real per-category 30d breakdown (incl. the NULL
 *     "Not itemized" bucket) + ONE monthly recurring $ input
 *     (components/adjustments-panel.tsx).
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
  const days = Math.max(1, baseline.periodDays);

  const plannedCost = (key: string): number =>
    projection.levers.find((l) => l.key === key)?.plannedCost ?? 0;

  // ── Rain planned/observed ratio (mirrors the model math, display only) ──
  const anchor = baseline.rainAnchor;
  const observedRainUsd = anchor ? anchor.count * anchor.avgPoolUsd : 0;
  const plannedRainEvents = (days * 24) / Math.max(0.05, seeds.rainDurationHours);
  const plannedRainUsd = plannedRainEvents * Math.max(0, seeds.rainPerEventUsd);

  return (
    <div className="space-y-4">
      {/* ── Raffles (keep-slider + live raffle cards) ─────────────────────── */}
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
            <RewardPanelTitle
              label="Races"
              dragPct={leverEdgeDragPct(projection, "races")}
            />
          }
          icon={Trophy}
          accent="rose"
        >
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

        {/* ── Rain — cadence + pool $, real `rains` anchor ────────────────── */}
        <StatPanel
          title={
            <RewardPanelTitle
              label="Rain"
              dragPct={leverEdgeDragPct(projection, "rain")}
            />
          }
          icon={CloudRain}
          accent="cyan"
        >
          {anchor == null || anchor.count <= 0 ? (
            <EmptyLever note="No completed rains found in the window (or the scan failed) — the rain cost stays at its canonical baseline value." />
          ) : (
            <>
              <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
                Real 30d anchor: {formatNumber(anchor.count)} rains ·{" "}
                {formatCurrency(anchor.avgPoolUsd)} avg pool · ~
                {anchor.avgDurationHours.toFixed(1)}h each · one every ~
                {anchor.avgIntervalHours.toFixed(1)}h. Cost scales the
                canonical net rain cost (max(0, wins − tips)) by the planned ÷
                observed pool-$ ratio.
              </p>
              <div className="space-y-2">
                <PlannerBudgetInput
                  label="Hours between rains"
                  value={seeds.rainDurationHours}
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
                  value={seeds.rainPerEventUsd}
                  seeded={levers.rainPerEventUsd == null}
                  onCommit={(next) =>
                    setLevers((s) => ({ ...s, rainPerEventUsd: next }))
                  }
                />
              </div>
              <div className="mt-3 space-y-0.5 border-t pt-3">
                <PanelRow
                  label="Observed pool $ (window)"
                  value={formatCurrency(observedRainUsd)}
                />
                <PanelRow
                  label="Planned pool $ (window)"
                  value={formatCurrency(plannedRainUsd)}
                />
                <PanelRow
                  label="Planned net rain cost (window)"
                  value={formatCurrency(plannedCost("rain"))}
                  valueClassName={TEXT_TONE.rose}
                />
              </div>
            </>
          )}
        </StatPanel>

        {/* ── Motha founder giveaways — ONE monthly $ budget ──────────────── */}
        <StatPanel
          title={
            <RewardPanelTitle
              label="Motha giveaways"
              dragPct={leverEdgeDragPct(projection, "motha")}
            />
          }
          icon={Crown}
          accent="purple"
        >
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
              dragPct={leverEdgeDragPct(projection, "gift-cards") +
                leverEdgeDragPct(projection, "promo-codes") +
                leverEdgeDragPct(projection, "other")}
            />
          }
          icon={Gift}
          accent="amber"
        >
          <p className="mb-3 text-[11px] leading-relaxed text-muted-foreground">
            Gift cards and promo codes are itemized from the real ledger legs
            and get their own monthly budgets; whatever&apos;s left of the
            &quot;other rewards&quot; bucket stays read-only.
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
              label="Gift cards (window real → planned)"
              value={
                <span className={`text-xs tabular-nums ${TEXT_TONE.rose}`}>
                  {formatCurrency(baseline.giftCardCost)} →{" "}
                  {formatCurrency(plannedCost("gift-cards"))}
                </span>
              }
            />
            <PanelRow
              label="Promo codes (window real → planned)"
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

      {/* ── Balance adjustments — real breakdown + ONE recurring $ input ──── */}
      <AdjustmentsPanel
        baseline={baseline}
        levers={levers}
        projection={projection}
        setLevers={setLevers}
      />
    </div>
  );
}
