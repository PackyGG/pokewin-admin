export const PACK_BUILDER_EDGE_MIN = 0.1095;
export const PACK_BUILDER_EDGE_MAX = 0.12;

export const PACK_BUILDER_EDGE_ERROR =
  "Pack Builder edge must be between 10.95% and 12.00%.";

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
