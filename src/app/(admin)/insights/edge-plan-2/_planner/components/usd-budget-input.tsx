"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * PlannerBudgetInput — one DIRECT numeric budget input for the Edge Plan 2.0
 * planner ($ / month, $ / event, hours, …). Replaces the old ×-multiplier
 * sliders per the 2026-06-12 overhaul: the owner types the number they think
 * in; clearing the box commits `null` = "re-seed from the real 30d run-rate"
 * (the `PlannedLeversV2` nullable-$ contract — null keeps profitDelta $0).
 *
 * Behavior mirrors the LeverSlider precise box (system-edge-plan/_planner-ui):
 * free typing in local state, commit on blur / Enter, a comma is tolerated as
 * the decimal separator, the value clamps to [min, max], and an invalid entry
 * reverts to the canonical value. Tone-neutral — House-POV coloring of any
 * planned/real readout stays owned by the calling panel.
 */
export function PlannerBudgetInput({
  label,
  value,
  onCommit,
  suffix = "$",
  min = 0,
  max,
  decimals = 2,
  seeded = false,
  disabled,
}: {
  label: string;
  /** The RESOLVED display value (the committed lever value, or its seed). */
  value: number;
  /**
   * Commit a parsed value, or `null` when the owner clears the box —
   * `null` means "drop back to the real run-rate seed".
   */
  onCommit: (next: number | null) => void;
  /** Unit suffix rendered inside the box ("$" default; "h" for hours). */
  suffix?: string;
  min?: number;
  max?: number;
  /** Decimal places the box snaps to (default 2). */
  decimals?: number;
  /** True while the lever is `null` (box is showing the run-rate seed). */
  seeded?: boolean;
  disabled?: boolean;
}) {
  const [text, setText] = React.useState(() => formatBox(value, decimals));
  const [focused, setFocused] = React.useState(false);

  // Re-sync to the canonical value when it changes from the OUTSIDE
  // (reset, preset load, the seed itself moving) and the box isn't focused.
  React.useEffect(() => {
    if (!focused) setText(formatBox(value, decimals));
  }, [value, decimals, focused]);

  const commit = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed === "") {
      // Cleared → back to the run-rate seed.
      onCommit(null);
      return;
    }
    const parsed = parseBoxInput(trimmed);
    if (parsed == null) {
      setText(formatBox(value, decimals));
      return;
    }
    const lo = Number.isFinite(min) ? min : 0;
    const clamped = Math.min(
      max != null && Number.isFinite(max) ? max : Number.POSITIVE_INFINITY,
      Math.max(lo, parsed),
    );
    onCommit(clamped);
    setText(formatBox(clamped, decimals));
  };

  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2",
        disabled && "opacity-50",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-xs font-medium text-foreground/90">
          {label}
        </span>
        {seeded && (
          <span className="shrink-0 rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
            run-rate
          </span>
        )}
      </span>
      <div className="relative shrink-0">
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
          className="h-7 min-h-7 w-28 overflow-visible py-0 pl-2 pr-6 text-right text-xs leading-none tabular-nums"
        />
        <span className="pointer-events-none absolute inset-y-0 right-1.5 flex items-center text-[10px] font-medium text-muted-foreground">
          {suffix}
        </span>
      </div>
    </div>
  );
}

/** Format a number for the box: trim to `decimals`, drop trailing zeros. */
function formatBox(n: number, decimals: number): string {
  if (!Number.isFinite(n)) return "";
  const fixed = n.toFixed(decimals);
  return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/** Parse typed box text — accepts comma or period decimals; period out. */
function parseBoxInput(raw: string): number | null {
  if (raw === "." || raw === ",") return null;
  const normalized = raw.replace(",", ".");
  if ((normalized.match(/\./g) ?? []).length > 1) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
