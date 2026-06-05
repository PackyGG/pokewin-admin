"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";
import { clamp } from "./_model";

/**
 * LeverSlider — one labeled what-if lever (a single-thumb `ui/slider` + a
 * value readout + an optional "current" baseline marker on the track).
 *
 * The marker shows where the REAL current value sits so the owner always sees
 * how far they've moved from production. House-POV is owned by the CALLER (the
 * value readout colour is decided by the panel), so this component stays
 * tone-neutral — it just renders the control + the baseline tick.
 *
 * All values are in the slider's own units (e.g. percent points); the caller
 * converts to/from fractions.
 */
export function LeverSlider({
  label,
  valueLabel,
  value,
  onValueChange,
  min,
  max,
  step,
  baselineMarker,
  baselineLabel,
  disabled,
}: {
  label: string;
  /** The formatted current value shown on the right (e.g. "0.25%"). */
  valueLabel: string;
  /** Current slider value (in slider units). */
  value: number;
  onValueChange: (next: number) => void;
  min: number;
  max: number;
  step: number;
  /** Where the REAL current value sits on the track (slider units), if any. */
  baselineMarker?: number;
  /** Tooltip / aria text for the baseline marker. */
  baselineLabel?: string;
  disabled?: boolean;
}) {
  // Position the baseline tick as a 0..100% offset along the track.
  const markerPct =
    baselineMarker != null && max > min
      ? clamp(((baselineMarker - min) / (max - min)) * 100, 0, 100)
      : null;

  return (
    <div className={cn("space-y-1.5", disabled && "opacity-50")}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-foreground/90">
          {label}
        </span>
        <span className="shrink-0 rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-xs font-semibold tabular-nums">
          {valueLabel}
        </span>
      </div>
      <div className="relative">
        <Slider
          value={value}
          onValueChange={onValueChange}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          aria-label={label}
        />
        {/* Baseline (current) marker — a thin vertical tick on the track. */}
        {markerPct != null && (
          <span
            aria-hidden
            title={baselineLabel}
            className="pointer-events-none absolute top-1/2 z-10 h-3 w-px -translate-y-1/2 bg-foreground/40"
            style={{ left: `calc(${markerPct}% )` }}
          />
        )}
      </div>
      {baselineLabel && (
        <p className="text-[10px] text-muted-foreground">{baselineLabel}</p>
      )}
    </div>
  );
}
