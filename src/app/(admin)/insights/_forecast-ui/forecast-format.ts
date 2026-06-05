/**
 * forecast-format.ts — PRESENTATIONAL helpers shared by the generic forecast
 * UI. NOT engine math (no economics live here — that's each reward's
 * `_forecast/`). Maps the serializable `LeverFormat` enum to the house
 * formatters so the controls render a lever's value identically everywhere.
 */

import type { LeverFormat } from "../_forecast-engine";
import { formatCurrency } from "@/lib/utils/format";
import { formatPct } from "../edge-calc/math";

/**
 * Format a lever's numeric value per its `LeverFormat`:
 *   • percent    → formatPct (fraction → "12.00%")
 *   • currency   → formatCurrency (USD)
 *   • multiplier → "1.25×"
 *   • number     → toFixed(decimals) (default 1)
 */
export function formatLeverValue(value: number, format: LeverFormat, decimals = 1): string {
  switch (format) {
    case "percent":
      return formatPct(value);
    case "currency":
      return formatCurrency(value);
    case "multiplier":
      return `${Number.isInteger(value) ? value : value.toFixed(2)}×`;
    case "number":
      return value.toFixed(decimals);
  }
}

/** Trim a leading "A · " / "E · " family prefix for compact chart axis labels. */
export function shortScenarioLabel(label: string): string {
  return label.replace(/^[A-Z]\s·\s/, "");
}
