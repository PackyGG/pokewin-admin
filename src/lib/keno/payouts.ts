/**
 * Canonical Keno game rules mirrored from the backend payout engine.
 *
 * Backend source: backend/src/utils/keno.ts (`getKenoMultiplier`).
 * The backend exposes the same rows through GET /v1/keno/multipliers in
 * development/test, but deliberately does not register any Keno routes in
 * production. The admin therefore needs this compile-time mirror to show the
 * complete configured paytable instead of guessing from settled games.
 *
 * When the backend paytable changes, update this file and its contract test in
 * the same release.
 */

export const KENO_GRID_SIZE = 40;
export const KENO_DRAW_COUNT = 10;
export const KENO_MIN_PICKS = 1;
export const KENO_MAX_PICKS = 10;
export const KENO_MIN_BET_USD = 0.25;
export const KENO_DEFAULT_MAX_BET_USD = 20;
export const KENO_DEFAULT_MAX_WIN_USD = 20_000;
export const KENO_MAX_CONFIGURABLE_BET_USD = 1_000;

export const KENO_RISK_MODES = ["low", "medium", "high"] as const;
export type KenoRiskMode = (typeof KENO_RISK_MODES)[number];

type PayoutRows = Record<number, readonly number[]>;

const LOW_PAYOUTS: PayoutRows = {
  1: [0.6, 1.9],
  2: [0, 1.9, 3.3],
  3: [0, 1, 1.33, 25],
  4: [0, 0, 1.9, 7.9, 90],
  5: [0, 0, 1.5, 3.5, 12, 300],
  6: [0, 0, 1, 2.1, 4.3, 99, 700],
  7: [0, 0, 1, 1.5, 3.2, 15.3, 224, 700],
  8: [0, 0, 1, 1.4, 1.9, 5.4, 40, 100, 800],
  9: [0, 0, 1, 1.2, 1.6, 2.6, 8.2, 50, 250, 1_000],
  10: [0, 0, 0.8, 1.1, 1.5, 2.2, 5, 15, 50, 250, 1_000],
};

const MEDIUM_PAYOUTS: PayoutRows = {
  1: [0.3, 2.8],
  2: [0, 1.7, 4.7],
  3: [0, 0, 2.3, 50],
  4: [0, 0, 1.4, 10, 100],
  5: [0, 0, 1.2, 4, 13, 390],
  6: [0, 0, 0, 2.5, 9, 180, 710],
  7: [0, 0, 0, 1.7, 6.8, 30, 400, 800],
  8: [0, 0, 0, 1.7, 4, 11, 67, 400, 900],
  9: [0, 0, 0, 1.7, 2.6, 5.2, 15, 100, 500, 1_000],
  10: [0, 0, 0, 1.3, 2, 4, 10, 26, 100, 500, 1_000],
};

const HIGH_PAYOUTS: PayoutRows = {
  1: [0, 3.7],
  2: [0, 0, 16],
  3: [0, 0, 0, 76.2],
  4: [0, 0, 0, 8.3, 260],
  5: [0, 0, 0, 3.6, 49, 450],
  6: [0, 0, 0, 0, 8.3, 350, 710],
  7: [0, 0, 0, 0, 5.5, 90, 410, 800],
  8: [0, 0, 0, 0, 4, 20, 280, 600, 900],
  9: [0, 0, 0, 0, 3.5, 11, 55, 460, 800, 1_000],
  10: [0, 0, 0, 0, 3, 8.2, 13, 63, 500, 800, 1_000],
};

export const KENO_PAYOUTS: Record<KenoRiskMode, PayoutRows> = {
  low: LOW_PAYOUTS,
  medium: MEDIUM_PAYOUTS,
  high: HIGH_PAYOUTS,
};

export function getKenoPayoutRow(
  risk: KenoRiskMode,
  picks: number,
): readonly number[] {
  return KENO_PAYOUTS[risk][picks] ?? [];
}

export function getKenoMultiplier(
  risk: KenoRiskMode,
  picks: number,
  hits: number,
): number {
  return getKenoPayoutRow(risk, picks)[hits] ?? 0;
}

export function combinations(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const size = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= size; index += 1) {
    result = (result * (n - size + index)) / index;
  }
  return result;
}

export function getKenoHitProbability(picks: number, hits: number): number {
  return (
    (combinations(picks, hits) *
      combinations(KENO_GRID_SIZE - picks, KENO_DRAW_COUNT - hits)) /
    combinations(KENO_GRID_SIZE, KENO_DRAW_COUNT)
  );
}

const TINY_PERCENT_FORMAT = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 3,
  notation: "standard",
  useGrouping: false,
});

/** Human-readable exact-hit probability without scientific notation. */
export function formatKenoProbability(value: number): string {
  if (value <= 0) return "0%";
  if (value >= 0.01) return `${(value * 100).toFixed(2)}%`;
  if (value >= 0.0001) return `${(value * 100).toFixed(4)}%`;
  return `${TINY_PERCENT_FORMAT.format(value * 100)}%`;
}

export function getKenoRtp(risk: KenoRiskMode, picks: number): number {
  return getKenoPayoutRow(risk, picks).reduce(
    (rtp, multiplier, hits) =>
      rtp + getKenoHitProbability(picks, hits) * multiplier,
    0,
  );
}

export function getKenoHouseEdge(
  risk: KenoRiskMode,
  picks: number,
): number {
  return 1 - getKenoRtp(risk, picks);
}

export function getKenoCappedPayout(
  bet: number,
  multiplier: number,
  maxWin: number,
): number {
  if (bet <= 0 || multiplier <= 0 || maxWin <= 0) return 0;
  return Math.min(bet * multiplier, maxWin);
}

export function getKenoEffectiveRtp(
  risk: KenoRiskMode,
  picks: number,
  bet: number,
  maxWin: number,
): number {
  if (bet <= 0) return 0;

  return getKenoPayoutRow(risk, picks).reduce(
    (rtp, multiplier, hits) =>
      rtp +
      getKenoHitProbability(picks, hits) *
        (getKenoCappedPayout(bet, multiplier, maxWin) / bet),
    0,
  );
}
