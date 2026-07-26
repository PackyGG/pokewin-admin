/**
 * Client-safe rakeback ROI constants.
 *
 * These plain runtime values are shared by both the server query module
 * (`@/lib/queries/insights-rewards/rakeback/roi`) and the `"use client"`
 * lookback filter. They MUST stay free of any server-only imports
 * (no `@/lib/db`, no `server-only`, no `next/headers`) so the
 * client bundle can pull them in without dragging the query module along.
 */

/** Default forward-lookback window (days) for rakeback ROI. */
export const RAKEBACK_ROI_LOOKBACK_DEFAULT = 14;

/** Selectable lookback windows (days) offered in the ROI tab UI. */
export const RAKEBACK_ROI_LOOKBACK_OPTIONS = [3, 7, 14, 30, 60] as const;

export type RakebackRoiLookback = (typeof RAKEBACK_ROI_LOOKBACK_OPTIONS)[number];

/**
 * Parse a raw query-param value into a valid lookback option, falling
 * back to the default when it isn't one of the allowed windows.
 */
export function parseRakebackRoiLookback(
  raw: string | undefined,
): RakebackRoiLookback {
  const num = Number(raw);
  if (Number.isFinite(num)) {
    for (const opt of RAKEBACK_ROI_LOOKBACK_OPTIONS) {
      if (opt === num) return opt;
    }
  }
  return RAKEBACK_ROI_LOOKBACK_DEFAULT;
}
