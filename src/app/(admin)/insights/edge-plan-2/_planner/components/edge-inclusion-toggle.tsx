"use client";

import * as React from "react";

import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { formatPct } from "../../../edge-calc/math";
import {
  isLeverIncludedInEdgeV2,
  type EdgeInclusionKey,
  type PlannedLeversV2,
} from "../../_model-v2";
import { EdgeDragBadge } from "./reward-edge-drag";

/**
 * Edge-inclusion toggle (owner spec #14) — the per-program "counts toward
 * edge" switch rendered in a reward box's title row, next to the edge chip.
 *
 * ON (default) = today's attribution. OFF = the program is EXCLUDED from
 * drag / planned-reward-cost / after-rewards-edge / planned-NGR (model side:
 * `isLeverIncludedInEdgeV2` inside `projectEdgePlanV2`). This is an
 * ATTRIBUTION control, NOT a $0 budget — the box's $ keeps displaying, the
 * chip greys out, and the page-level transparency footnote lists the
 * exclusions (`projection.excludedPrograms`, creator-costs-footnote pattern).
 */
export function EdgeInclusionToggle({
  leverKey,
  levers,
  setLevers,
}: {
  leverKey: EdgeInclusionKey;
  levers: PlannedLeversV2;
  setLevers: React.Dispatch<React.SetStateAction<PlannedLeversV2>>;
}) {
  const included = isLeverIncludedInEdgeV2(levers, leverKey);
  return (
    <div
      className="flex shrink-0 items-center gap-1.5"
      title={
        included
          ? "Counts toward edge — switch OFF to exclude this program from edge / NGR attribution (its $ stays displayed and is listed in the exclusions footnote)."
          : "Excluded from edge / NGR attribution — the $ stays displayed and is listed in the exclusions footnote. Switch ON to restore today's attribution."
      }
    >
      <span
        className={cn(
          "whitespace-nowrap text-[10px] font-medium uppercase tracking-wide",
          included
            ? "text-muted-foreground"
            : "text-amber-600 dark:text-amber-400",
        )}
      >
        {included ? "Counts toward edge" : "Excluded"}
      </span>
      <Switch
        checked={included}
        onCheckedChange={(v) =>
          setLevers((s) => ({
            ...s,
            edgeInclusion: { ...s.edgeInclusion, [leverKey]: v === true },
          }))
        }
        aria-label={`Counts toward edge — ${leverKey}`}
      />
    </div>
  );
}

/**
 * Inclusion-aware panel title: label + the edge chip. When the program is
 * included this is exactly the shared `RewardPanelTitle` rendering (live
 * `EdgeDragBadge`); when excluded the chip GREYS OUT (spec #14 — the drag
 * figure stays visible for transparency but is visibly non-attributed).
 */
export function InclusionAwareRewardTitle({
  label,
  dragPct,
  included,
}: {
  label: string;
  dragPct: number;
  included: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <span className="truncate">{label}</span>
      {included ? (
        <EdgeDragBadge dragPct={dragPct} />
      ) : (
        <GreyedEdgeChip dragPct={dragPct} />
      )}
    </span>
  );
}

/** The greyed (excluded) variant of the edge chip — same figure, muted tone. */
function GreyedEdgeChip({ dragPct }: { dragPct: number }) {
  const hasFigure =
    Number.isFinite(dragPct) && Math.abs(dragPct) >= 0.00005;
  const text = hasFigure
    ? `${dragPct > 0 ? "−" : "+"}${formatPct(Math.abs(dragPct))} edge · excluded`
    : "excluded";
  return (
    <span
      className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold tabular-nums normal-case tracking-normal text-muted-foreground"
      title="Excluded from edge attribution (owner toggle) — not counted in drag, planned reward cost, after-rewards edge, or planned NGR."
    >
      {text}
    </span>
  );
}
