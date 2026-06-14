import { TARGET_HOUSE_EDGE } from "@/app/(admin)/insights/edge-calc/math";

/**
 * Drop chance for one slot in a weighted pack pool (0–100 scale).
 * Matches getPackDetail: probability = (weight / totalWeight) × 100.
 */
export function probabilityPercentFromWeight(
  weight: number,
  totalWeight: number,
): number {
  if (!Number.isFinite(weight) || weight <= 0 || totalWeight <= 0) return 0;
  return (weight / totalWeight) * 100;
}

/**
 * Expected pack openings until the target card is pulled once, assuming
 * independent draws with replacement from the same weighted pool.
 *
 *   E[openings] = 1 / p   where p is the per-slot probability (0–1).
 */
export function expectedOpeningsFromProbabilityPercent(
  probabilityPercent: number,
): number | null {
  if (!Number.isFinite(probabilityPercent) || probabilityPercent <= 0) {
    return null;
  }
  return 100 / probabilityPercent;
}

/**
 * Theoretical house profit until the card is expected to drop, using a
 * fixed planning house edge on pack sticker price (default 10.99%).
 *
 *   profit = expectedOpenings × packPrice × houseEdge
 *
 * This is a planning estimate — it assumes every open pays full pack price
 * and the pack carries the target theoretical edge, not realized RTP.
 */
export function theoreticalHouseProfitUsd(
  expectedOpenings: number,
  packPriceUsd: number,
  houseEdge: number = TARGET_HOUSE_EDGE,
): number {
  if (
    !Number.isFinite(expectedOpenings) ||
    expectedOpenings <= 0 ||
    !Number.isFinite(packPriceUsd) ||
    packPriceUsd <= 0
  ) {
    return 0;
  }
  return expectedOpenings * packPriceUsd * houseEdge;
}

/** Display helper — mirrors /packs/[id] drop-chance formatting. */
export function formatDropChancePercent(probabilityPercent: number): string {
  if (probabilityPercent <= 0) return "0%";
  return probabilityPercent < 0.01
    ? `${probabilityPercent.toFixed(4)}%`
    : `${probabilityPercent.toFixed(2)}%`;
}

/** Human-readable expected openings (whole number when close). */
export function formatExpectedOpenings(value: number | null): string {
  if (value == null) return "—";
  if (value >= 100) return Math.round(value).toLocaleString();
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}
