export const PACK_BUILDER_EDGE_MIN = 0.1095;
export const PACK_BUILDER_EDGE_MAX = 0.115;

export const PACK_BUILDER_EDGE_ERROR =
  "Pack Builder edge must be between 10.95% and 11.50%.";

export const PACK_BUILDER_TICKET_TOTAL = 1_000_000;
const PACK_BUILDER_TICKET_TOTAL_ERROR =
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

/**
 * Rescale a proportional weight vector (what `shapeWeights` returns — integer
 * weights, gcd-reduced, arbitrary total) onto EXACTLY
 * {@link PACK_BUILDER_TICKET_TOTAL} tickets, so the persisted pack odds sum to
 * exactly 100.0000%. Largest-remainder distribution: proportions are preserved
 * to within one ticket (1e-4 pp) per card, zero stays zero, and every card that
 * carried weight keeps at least one ticket. Returns `null` when the input can't
 * be expressed on the grid (empty, non-finite, all-zero, or more weighted cards
 * than tickets).
 */
export function scaleToPackBuilderTickets(
  weights: readonly number[],
): number[] | null {
  if (weights.length === 0) return null;
  if (!weights.every((weight) => Number.isFinite(weight) && weight >= 0)) {
    return null;
  }
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) return null;

  const exact = weights.map(
    (weight) => (weight / total) * PACK_BUILDER_TICKET_TOTAL,
  );
  const tickets = exact.map((value, index) =>
    weights[index]! > 0 ? Math.max(1, Math.floor(value)) : 0,
  );
  let remaining =
    PACK_BUILDER_TICKET_TOTAL - tickets.reduce((sum, value) => sum + value, 0);
  if (remaining < 0) return null;

  // Hand the leftover tickets out by descending fractional part (index breaks
  // ties) so the distribution is deterministic.
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .filter((entry) => weights[entry.index]! > 0)
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  if (order.length === 0) return null;
  for (let i = 0; remaining > 0; i++) {
    const target = order[i % order.length]!.index;
    tickets[target] = tickets[target]! + 1;
    remaining -= 1;
  }

  return tickets;
}

export function getPackBuilderTicketTotalError(
  weights: readonly number[],
): string | null {
  return hasExactPackBuilderTicketTotal(weights)
    ? null
    : PACK_BUILDER_TICKET_TOTAL_ERROR;
}
