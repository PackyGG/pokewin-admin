/**
 * constants.ts — GENERIC, reward-agnostic constants for the shared forecast
 * orchestration.
 *
 * Only coefficients the GENERIC layer (`simulateSet` / `scaleResultMoney` /
 * `buildDailySeries` / `recommend`) needs live here. Reward-SPECIFIC
 * coefficients (cap thresholds, burst damping, friction weights, segment mixes,
 * …) stay in the reward's own `_forecast/constants.ts`.
 */

// ─── Accent colors (house UI palette, House-POV) ────────────────────────────

/**
 * Tile accent keys understood by `modern-panels.tsx` (`TILE_COLORS`). The
 * canonical list lives next to the UI primitives; this mirror keeps the engine
 * dep-free (no React import). Keep in sync with `TILE_COLORS`.
 */
export type AccentColor =
  | "blue"
  | "emerald"
  | "rose"
  | "cyan"
  | "amber"
  | "purple"
  | "orange"
  | "pink";

// ─── Numerical guards ───────────────────────────────────────────────────────

/** Smallest denominator we treat as non-zero before short-circuiting to 0. */
export const EPSILON = 1e-9;

// ─── Shared model coefficients ──────────────────────────────────────────────

/**
 * Default ±band on projected cost: ±15% (confidence interval, not a guarantee).
 * A reward may override its own band, but the orchestration uses this when a
 * reward's `simulate` leaves the band centered on cost without a spread.
 */
export const CONFIDENCE_BAND_SPREAD = 0.15;

/** Hours per day — used by day/window conversions across reward engines. */
export const HOURS_PER_DAY = 24;

/**
 * Flat daily-pacing front-load factor (1 = perfectly even spread across the
 * horizon). The generic `buildDailySeries` default when a reward supplies no
 * per-scenario front-load. >1 front-loads day 0; the curve always integrates
 * EXACTLY to the supplied total (no drift).
 */
export const FLAT_FRONTLOAD = 1.0;
