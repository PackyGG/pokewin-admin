export const PACK_BUILDER_EDGE_MIN = 0.1095;
export const PACK_BUILDER_EDGE_MAX = 0.115;

export const PACK_BUILDER_EDGE_ERROR =
  "Pack Builder edge must be between 10.95% and 11.50%.";

export const PACK_BUILDER_TICKET_TOTAL = 1_000_000;
export const PACK_BUILDER_TICKET_TOTAL_ERROR =
  "Pack Builder ticket weights must total exactly 100.0000%.";

export function isPackBuilderEdgeInRange(edge: number): boolean {
  return (
    Number.isFinite(edge) &&
    edge >= PACK_BUILDER_EDGE_MIN &&
    edge <= PACK_BUILDER_EDGE_MAX
  );
}

export function clampPackBuilderEdge(edge: number): number {
  if (!Number.isFinite(edge)) return PACK_BUILDER_EDGE_MIN;
  return Math.min(
    PACK_BUILDER_EDGE_MAX,
    Math.max(PACK_BUILDER_EDGE_MIN, edge),
  );
}

export function getPackBuilderEdgeError(edge: number): string | null {
  return isPackBuilderEdgeInRange(edge) ? null : PACK_BUILDER_EDGE_ERROR;
}

export function hasExactPackBuilderTicketTotal(
  weights: readonly number[],
): boolean {
  return (
    weights.length > 0 &&
    weights.every(
      (weight) => Number.isInteger(weight) && Number.isFinite(weight) && weight >= 0,
    ) &&
    weights.reduce((total, weight) => total + weight, 0) ===
      PACK_BUILDER_TICKET_TOTAL
  );
}

export function getPackBuilderTicketTotalError(
  weights: readonly number[],
): string | null {
  return hasExactPackBuilderTicketTotal(weights)
    ? null
    : PACK_BUILDER_TICKET_TOTAL_ERROR;
}
