import type { CreatorDealResponse } from "@/lib/backend-api/contracts";

type ApprovalMarker = { requestId: string; periodIndex: number };

function marker(deal: CreatorDealResponse): ApprovalMarker | null {
  if (deal.terms == null || typeof deal.terms !== "object") return null;
  const terms = deal.terms as Record<string, unknown>;
  const requestId = terms.creator_approval_request_id;
  const periodIndex = terms.creator_approval_period_index;
  if (typeof requestId !== "string") return null;
  if (typeof periodIndex !== "number" || !Number.isInteger(periodIndex)) {
    return null;
  }
  return { requestId, periodIndex };
}

/** Resolve every backend row created for each approval, ordered by period. */
export function indexCreatorApprovalDealIds(
  deals: CreatorDealResponse[],
): Map<string, string[]> {
  const indexed = new Map<string, Array<{ id: string; periodIndex: number }>>();
  for (const deal of deals) {
    const approval = marker(deal);
    if (!approval) continue;
    const entries = indexed.get(approval.requestId) ?? [];
    entries.push({ id: deal.id, periodIndex: approval.periodIndex });
    indexed.set(approval.requestId, entries);
  }
  return new Map(
    [...indexed].map(([requestId, entries]) => [
      requestId,
      entries
        .sort((left, right) => left.periodIndex - right.periodIndex)
        .map((entry) => entry.id),
    ]),
  );
}

