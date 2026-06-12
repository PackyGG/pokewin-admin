"use client";

import * as React from "react";
import { Clock3, Ticket, Users } from "lucide-react";

import { StatPanel, PanelRow } from "@/components/modern-panels";
import {
  formatCompactUsd,
  formatCurrency,
  formatDateTime,
  formatNumber,
} from "@/lib/utils/format";
import { LeverSlider } from "../../../system-edge-plan/_planner-ui";
import {
  clamp,
  type EdgePlanV2Baseline,
  type EdgePlanV2Projection,
  type LiveRaffleInfo,
  type PlannedLeversV2,
} from "../../_model-v2";
import { TEXT_TONE } from "../colors";
import { EmptyLever, formatPercentInt } from "../components/empty-lever";
import { LeverHint } from "../components/lever-hint";
import {
  leverEdgeDragPct,
  RewardPanelTitle,
} from "../components/reward-edge-drag";

/**
 * RaffleKeepPanel — raffles in the 2026-06-12 overhaul: the three ×-multiplier
 * levers are GONE, replaced by ONE keep-slider (0–100%) that scales the real
 * 30d reconstructed raffle prize cost (`baseline.raffleCost`, valued at live
 * pack/card prices). 100% = keep the current program, 0% = raffles off.
 * The planned $ flows through the projection's "raffles" lever row.
 *
 * Below the slider: the currently-live (status=active) raffles as read-only
 * context cards from `baseline.liveRaffles` — prize value at live prices via
 * the shared prize-valuation helper. Prizes go OUT to users → house cost →
 * House-POV rose.
 *
 * Consumed by `sections/giveaways.tsx` (the "Giveaways & budgets" workspace);
 * `RafflesSection` stays exported as a thin alias for any older wiring.
 */
export function RaffleKeepPanel({
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
  const keepPct = clamp(levers.raffleKeepPct, 0, 1);

  // Planned raffle prize cost from the shared "raffles" lever row.
  const rafflesLever = projection.levers.find((l) => l.key === "raffles");
  const plannedRaffleCost =
    rafflesLever?.plannedCost ?? baseline.raffleCost * keepPct;

  return (
    <StatPanel
      title={
        <RewardPanelTitle
          label="Raffles"
          dragPct={leverEdgeDragPct(projection, "raffles")}
        />
      }
      icon={Ticket}
      accent="rose"
    >
      <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
        On-site ticket raffles — prizes pay out pack/card items, valued at the
        live price. Real reconstructed prize cost this window:{" "}
        <span className={`font-medium ${TEXT_TONE.rose}`}>
          {formatCurrency(baseline.raffleCost)}
        </span>
        . One keep-slider scales it: 100% keeps the current program, 0% turns
        raffles off.
      </p>

      <PanelRow
        label="Real reconstructed raffle prize cost (window)"
        value={
          <span className={`font-semibold ${TEXT_TONE.rose}`}>
            {formatCurrency(baseline.raffleCost)}
          </span>
        }
      />
      <PanelRow
        label="Planned raffle prize cost (window)"
        value={
          <span className={`font-semibold ${TEXT_TONE.rose}`}>
            {formatCurrency(plannedRaffleCost)}
          </span>
        }
      />

      {baseline.raffleCost <= 0 ? (
        <div className="mt-2">
          <EmptyLever note="No reconstructed raffle prize cost in this window — nothing to scale." />
        </div>
      ) : (
        <div className="mt-2">
          <LeverHint hint="Share of the current raffle program you keep. Cost scales straight with it — 50% halves the raffle prize spend, 0% removes it.">
            <LeverSlider
              label="Keep raffles at"
              valueLabel={formatPercentInt(keepPct * 100)}
              value={keepPct * 100}
              onValueChange={(pct) =>
                setLevers((s) => ({
                  ...s,
                  raffleKeepPct: clamp(pct / 100, 0, 1),
                }))
              }
              min={0}
              max={100}
              step={1}
              baselineMarker={100}
              baselineLabel="100% = current program (real 30d reconstructed cost)"
              preciseInput={{ unit: "percent", decimals: 0 }}
            />
          </LeverHint>
        </div>
      )}

      {/* ── Currently-live raffles (read-only context) ──────────────────── */}
      <div className="mt-4 border-t pt-3">
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Currently live raffles · {formatNumber(baseline.liveRaffles.length)}
        </p>
        {baseline.liveRaffles.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No raffle is live right now.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {baseline.liveRaffles.map((raffle) => (
              <LiveRaffleCard key={raffle.id} raffle={raffle} />
            ))}
          </div>
        )}
      </div>
    </StatPanel>
  );
}

const MAX_PRIZE_LINES = 3;

function LiveRaffleCard({ raffle }: { raffle: LiveRaffleInfo }) {
  const shown = raffle.prizes.slice(0, MAX_PRIZE_LINES);
  const hidden = raffle.prizes.length - shown.length;

  return (
    <div className="rounded-lg border bg-background/40 p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-xs font-semibold text-foreground">
          {raffle.title ?? "Untitled raffle"}
        </p>
        <span
          className={`shrink-0 text-xs font-semibold tabular-nums ${TEXT_TONE.rose}`}
        >
          {formatCompactUsd(raffle.prizeValueUsd)}
        </span>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Ticket className="size-3" aria-hidden />
          {formatNumber(raffle.totalEntries)} entries
        </span>
        <span className="inline-flex items-center gap-1">
          <Users className="size-3" aria-hidden />
          {formatNumber(raffle.participantCount)} participants
        </span>
        <span className="inline-flex items-center gap-1">
          <Clock3 className="size-3" aria-hidden />
          {raffle.endsAt ? `ends ${formatDateTime(raffle.endsAt)}` : "no end set"}
        </span>
      </div>

      {shown.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {shown.map((line, i) => (
            <p
              key={`${line.type}-${line.id}-${i}`}
              className="flex items-center justify-between gap-2 text-[10px] tabular-nums text-muted-foreground"
            >
              <span className="min-w-0 truncate">
                {formatNumber(line.quantity)}× {line.type}
              </span>
              <span className="shrink-0">
                {formatCurrency(line.unitPriceUsd)} ea
              </span>
            </p>
          ))}
          {hidden > 0 && (
            <p className="text-[10px] text-muted-foreground/70">
              +{hidden} more prize line{hidden === 1 ? "" : "s"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Back-compat alias — older wiring imported `RafflesSection`. */
export { RaffleKeepPanel as RafflesSection };
