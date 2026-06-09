"use client";

import * as React from "react";

import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import { clamp } from "./_model";

/**
 * The natural display unit of a lever's PRECISE numeric input. The slider value
 * is always carried in the slider's own units (the caller's `value` /
 * `onValueChange` contract is unchanged); this only controls how the adjacent
 * exact-input box presents + parses that value so the owner can type a real
 * value in the unit they think in — not raw slider points:
 *
 *   • "percent"    — slider units ARE percent points (e.g. edge 0..30, rakeback
 *                    0..N). The box shows/edits the percent value directly
 *                    (typing 15.55 → 15.55%). 1:1 with slider units.
 *   • "multiplier" — slider units are `mult × 100` (e.g. 150 ⇒ 1.5×). The box
 *                    shows/edits the MULTIPLIER (1.5), converting ×100 on the way
 *                    back to slider units. So the owner types "1.5", not "150".
 *   • "usd"        — slider units ARE dollars (signup grant). 1:1, shown as a
 *                    plain number.
 */
export type PreciseInputUnit = "percent" | "multiplier" | "usd";

/**
 * Convert a slider-unit value into the precise input's display number, per unit.
 * Pure + exported for unit-testing the round-trip.
 */
export function sliderToInput(value: number, unit: PreciseInputUnit): number {
  return unit === "multiplier" ? value / 100 : value;
}

/**
 * Convert a typed display number back into slider units, per unit. Pure +
 * exported for unit-testing the round-trip.
 */
export function inputToSlider(display: number, unit: PreciseInputUnit): number {
  return unit === "multiplier" ? display * 100 : display;
}

/**
 * LeverSlider — one labeled what-if lever: a single-thumb `ui/slider` + a value
 * readout + an optional PRECISE numeric input (type an exact value at fine
 * precision) + an optional "current" baseline marker on the track.
 *
 * The marker shows where the REAL current value sits so the owner always sees
 * how far they've moved from production. House-POV is owned by the CALLER (the
 * value readout colour is decided by the panel), so this component stays
 * tone-neutral — it just renders the control + the baseline tick + the box.
 *
 * All values flow through `onValueChange` in the slider's own units (e.g.
 * percent points), so the slider, the precise input, AND a loaded preset all
 * drive the projection through the EXACT same path — there is no second source
 * of truth. The precise input only changes the precision/unit the owner *types*
 * in; it cannot produce a value the slider couldn't (it clamps to [min,max]).
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
  preciseInput,
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
  /**
   * Render an exact-value numeric input next to the slider. The owner can type
   * a precise value (finer than the slider step) in the lever's natural unit;
   * it clamps to [min,max] and drives the SAME `onValueChange` as the slider.
   * Omit to render the slider only.
   */
  preciseInput?: {
    /** Natural display unit (drives the box's value + suffix). */
    unit: PreciseInputUnit;
    /** Decimal places the box accepts/snaps to (default 2 — 0.01 precision). */
    decimals?: number;
    /** Step attribute for the box (default derived from `decimals`). */
    inputStep?: number;
  };
}) {
  // Position the baseline tick as a 0..100% offset along the track.
  const markerPct =
    baselineMarker != null && max > min
      ? clamp(((baselineMarker - min) / (max - min)) * 100, 0, 100)
      : null;

  const unit = preciseInput?.unit;
  const decimals = preciseInput?.decimals ?? 2;
  // Slider-unit bounds expressed in the box's display unit.
  const inMin = unit ? sliderToInput(min, unit) : min;
  const inMax = unit ? sliderToInput(max, unit) : max;
  const unitSuffix = unit === "percent" ? "%" : unit === "multiplier" ? "×" : "$";

  // Local text state so the owner can type freely (incl. an intermediate
  // empty / "1." string) without the controlled value snapping mid-keystroke.
  // It re-syncs to the canonical value whenever that value changes from the
  // OUTSIDE (slider drag, reset, preset load) and the box isn't focused.
  const displayValue = unit ? sliderToInput(value, unit) : value;
  const [text, setText] = React.useState(() => formatBox(displayValue, decimals));
  const [focused, setFocused] = React.useState(false);
  React.useEffect(() => {
    if (!focused) setText(formatBox(displayValue, decimals));
  }, [displayValue, decimals, focused]);

  const commit = (raw: string) => {
    const parsed = parseBoxInput(raw);
    if (parsed == null) {
      // Revert to the canonical value on an empty / invalid entry.
      setText(formatBox(displayValue, decimals));
      return;
    }
    const clampedDisplay = clamp(parsed, inMin, inMax);
    const sliderUnits = unit ? inputToSlider(clampedDisplay, unit) : clampedDisplay;
    onValueChange(sliderUnits);
    setText(formatBox(clampedDisplay, decimals));
  };

  return (
    <div className={cn("space-y-1.5", disabled && "opacity-50")}>
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-foreground/90">
          {label}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          {preciseInput && (
            <div className="relative">
              <Input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={text}
                disabled={disabled}
                aria-label={`${label} exact value`}
                onFocus={() => setFocused(true)}
                onChange={(e) => setText(e.target.value)}
                onBlur={(e) => {
                  setFocused(false);
                  commit(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commit((e.target as HTMLInputElement).value);
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                className={cn(
                  "h-7 min-h-7 w-[4.75rem] overflow-visible py-0 pl-2 pr-5 text-right text-xs leading-none tabular-nums",
                )}
              />
              <span className="pointer-events-none absolute inset-y-0 right-1.5 flex items-center text-[10px] font-medium text-muted-foreground">
                {unitSuffix}
              </span>
            </div>
          )}
          <span className="rounded-md border border-border/60 bg-muted/40 px-1.5 py-0.5 text-xs font-semibold tabular-nums">
            {valueLabel}
          </span>
        </div>
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

/** Format a number for the box: trim to `decimals`, drop trailing zeros. */
function formatBox(n: number, decimals: number): string {
  if (!Number.isFinite(n)) return "";
  // Round to the box precision, then strip trailing zeros so "1.50" → "1.5"
  // and "15.00" → "15" read cleanly while still allowing fine entry.
  const fixed = n.toFixed(decimals);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** Parse typed box text — accepts comma or period decimals; always period out. */
function parseBoxInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "." || trimmed === ",") return null;
  // Admin UI uses period decimals; tolerate a single comma as decimal separator.
  const normalized = trimmed.replace(",", ".");
  if ((normalized.match(/\./g) ?? []).length > 1) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
