import type { CreatorDealResponse } from "@/lib/backend-api/contracts";

export type CreatorApprovalDealMarker = {
  requestId: string;
  periodIndex: number;
  periodCount: number | null;
};

export function getCreatorApprovalDealMarker(
  deal: CreatorDealResponse,
): CreatorApprovalDealMarker | null {
  if (deal.terms == null || typeof deal.terms !== "object") return null;
  const terms = deal.terms as Record<string, unknown>;
  const requestId = terms.creator_approval_request_id;
  const periodIndex = terms.creator_approval_period_index;
  const periodCount = terms.creator_approval_period_count;
  if (typeof requestId !== "string") return null;
  if (typeof periodIndex !== "number" || !Number.isInteger(periodIndex)) {
    return null;
  }
  return {
    requestId,
    periodIndex,
    periodCount:
      typeof periodCount === "number"
      && Number.isInteger(periodCount)
      && periodCount > 0
        ? periodCount
        : null,
  };
}

/** Active and upcoming backend periods that belong in the current Deal card. */
export function selectLiveCreatorDealPeriods(
  deals: CreatorDealResponse[],
): CreatorDealResponse[] {
  return deals
    .filter((deal) => deal.status === "active" || deal.status === "scheduled")
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === "active" ? -1 : 1;
      return left.week_start_utc.localeCompare(right.week_start_utc);
    });
}

/** Resolve every backend row created for each approval, ordered by period. */
export function indexCreatorApprovalDealIds(
  deals: CreatorDealResponse[],
): Map<string, string[]> {
  const indexed = new Map<string, Array<{ id: string; periodIndex: number }>>();
  for (const deal of deals) {
    const approval = getCreatorApprovalDealMarker(deal);
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
