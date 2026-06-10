"use client";

import * as React from "react";
import { Ticket } from "lucide-react";

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
import { TEXT_TONE } from "../colors";
import { EmptyLever } from "../components/empty-lever";
import {
  leverEdgeDragPct,
  RewardPanelTitle,
} from "../components/reward-edge-drag";

/**
 * RafflesSection — on-site ticket raffles, restored in Edge Plan 2.0 on the real
 * reconstructed raffle prize cost (`baseline.raffleCost` =
 * `getRaffleForecastBaseline().totalPrizeCost`). Raffles pay out pack/card ITEMS,
 * so the cost is reconstructed at the live pack/card price — it is a real reward
 * cost, distinct from races.
 *
 * Raffle prizes go OUT to users → this is a house cost → House-POV rose. Three
 * multiplier what-if levers (prize pool × draw frequency × ticket-cost) project
 * the real cost through the shared v1 raffle factor; the projected drag flows
 * through the "raffles" lever row.
 */
export function RafflesSection({
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

  // Projected raffle prize cost (planned), from the shared "raffles" lever row.
  const rafflesLever = projection.levers.find((l) => l.key === "raffles");
  const plannedRaffleCost = rafflesLever?.plannedCost ?? baseline.raffleCost;

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
        On-site ticket raffles — users earn tickets per $X wagered and prizes pay
        out pack/card items, valued at the live price. Reconstructed prize cost
        this window:{" "}
        <span className={`font-medium ${TEXT_TONE.rose}`}>
          {formatCurrency(baseline.raffleCost)}
        </span>
        {baseline.raffleCost > 0 && (
          <>
            {" "}
            · planned{" "}
            <span className={`font-medium ${TEXT_TONE.rose}`}>
              {formatCurrency(plannedRaffleCost)}
            </span>
          </>
        )}
        .
      </p>
      <PanelRow
        label="Real reconstructed raffle prize cost"
        value={formatCurrency(baseline.raffleCost)}
      />
      {baseline.raffleCost <= 0 ? (
        <EmptyLever note="No reconstructed raffle prize cost in this window." />
      ) : (
        <>
          <p className="text-xs leading-relaxed text-muted-foreground">
            x multipliers on the current real raffle program. Prize pool = total
            prize money (scales cost linearly). Frequency = how often raffles are
            drawn — 2x = twice as many draws, roughly 2x the cost. Ticket cost =
            how hard tickets are to earn (raising it slightly deters farming, so a
            touch less cost).
          </p>
          <LeverSlider
            label="Prize pool"
            valueLabel={multLabel(levers.rafflePrizePoolMult)}
            value={levers.rafflePrizePoolMult * 100}
            onValueChange={setMult("rafflePrizePoolMult")}
            min={0}
            max={300}
            step={1}
            baselineMarker={100}
            baselineLabel="1× = current reconstructed pool"
            preciseInput={{ unit: "multiplier" }}
          />
          <LeverSlider
            label="Frequency"
            valueLabel={multLabel(levers.raffleFrequencyMult)}
            value={levers.raffleFrequencyMult * 100}
            onValueChange={setMult("raffleFrequencyMult")}
            min={0}
            max={300}
            step={1}
            baselineMarker={100}
            baselineLabel="1× = current draw cadence"
            preciseInput={{ unit: "multiplier" }}
          />
          <LeverSlider
            label="Ticket cost"
            valueLabel={multLabel(levers.raffleTicketCostMult)}
            value={levers.raffleTicketCostMult * 100}
            onValueChange={setMult("raffleTicketCostMult")}
            min={0}
            max={300}
            step={1}
            baselineMarker={100}
            baselineLabel="1× = current ticket rate (higher = harder entry)"
            preciseInput={{ unit: "multiplier" }}
          />
        </>
      )}
    </StatPanel>
  );
}
