import "server-only";

import { creatorsApi } from "@/lib/backend-api";
import { getConvertedFromVouchersByDeal } from "./converted-from-vouchers-by-deal";
import { getWithdrawnFromConvertedByDeal } from "./withdrawn-from-converted-by-deal";

export type CreatorsGlobalStats = {
  /** Total creator accounts on the platform. */
  totalCreators: number;
  /**
   * Count of creators with at least one fill (weekly) deal —
   * `total_deals_count > 0` on the backend creator-list row. Fill and
   * multiplier are the two creator-deal programs; this is the "Fill
   * Creators" KPI, paired with the separate multiplier-creator count.
   */
  fillCreatorCount: number;
  /**
   * Count of creators whose `current_deal` is either ACTIVE (running
   * right now) or SCHEDULED (signed off and queued to start). Matches
   * the highlighted "Active" badge admins already see on each card —
   * the badge fires for both statuses, so the KPI count needs to too
   * or the numbers will read inconsistent.
   */
  activeDealCount: number;
  /**
   * Count of creators currently live — backend signal is
   * `active_session_id !== null`. Updates as creators go live on
   * kick / start their stream session for the deal.
   */
  liveCount: number;
  /**
   * Total "Converted" — combined value of the end-of-session payout
   * vouchers (`vouchers.origin = 'creator_fill_conversion'`) MINTED
   * across every creator with an active or scheduled deal: how much
   * stream earnings have actually been converted into payout vouchers
   * (§2 of the creator model). Sourced from the Main-DB `vouchers`
   * table — the SAME voucher set the withdrawn sub-line reads — NOT the
   * backend deal's `withdraw_cap_used_usd` cap-consumption counter
   * (which is admin-mutable and per deal-version, so it's the wrong
   * source for a minted-voucher figure). Best-effort — a query failure
   * leaves this at 0 rather than crashing the tile.
   */
  convertedTotal: number;
  /**
   * Of `convertedTotal` (payout vouchers minted from conversion), how
   * much has actually left the platform via a completed
   * card_withdrawal_requests row, summed across every active/
   * scheduled deal in scope. Reads the SAME `creator_fill_conversion`
   * voucher set as `convertedTotal`, so `withdrawn ≤ converted` holds
   * by construction.
   */
  withdrawnFromConvertedTotal: number;
  /**
   * Same scope as `withdrawnFromConvertedTotal`, but for in-flight
   * withdraw requests (pending / processing / shipped) — i.e.
   * already requested but not yet terminal.
   */
  withdrawPendingFromConvertedTotal: number;
};

/**
 * Global counts for the /creators KPI strip. Independent from the
 * paginated list query so the stats don't change when the user types
 * in the search box.
 *
 * The backend caps `limit` at 100 per request (validation rejects
 * anything bigger with HTTP 422 — earlier code that asked for 1000
 * silently 422'd and the KPI tiles rendered "—"). We page through
 * `total` in 100-row chunks; with parallelism so the round-trips
 * overlap. A hard upper bound on the number of pages prevents a
 * runaway loop if `total` is reported wrong.
 */
const PAGE_SIZE = 100;
const MAX_PAGES = 50; // 5,000 creators — way above current/projected pool.

export async function getCreatorsGlobalStats(): Promise<CreatorsGlobalStats> {
  // First page also tells us the absolute total. Once we know the
  // total we can request the remaining pages in parallel.
  const firstPage = await creatorsApi.list({
    // No search filter — these are global counts. If the user types
    // in the search box, the KPI tiles should stay stable.
    offset: 0,
    limit: PAGE_SIZE,
  });

  const pagesNeeded = Math.min(
    MAX_PAGES,
    Math.ceil(firstPage.total / PAGE_SIZE),
  );

  // Build the list of additional pages (skip page 0, we already have it).
  const remainingPagePromises: Promise<typeof firstPage>[] = [];
  for (let p = 1; p < pagesNeeded; p++) {
    remainingPagePromises.push(
      creatorsApi.list({ offset: p * PAGE_SIZE, limit: PAGE_SIZE }),
    );
  }
  const remainingPages = await Promise.all(remainingPagePromises);

  // Count predicates across every page we fetched. `activeDeals`
  // collects the (creator, deal) id pairs whose deal is active or
  // scheduled — the set we resolve withdraw-cap usage for below.
  let activeDealCount = 0;
  let liveCount = 0;
  // Creators with ≥1 fill (weekly) deal — total_deals_count is the
  // backend's lifetime fill-deal count for the creator.
  let fillCreatorCount = 0;
  const activeDeals: { userId: string; dealId: string }[] = [];
  const tallyPage = (rows: typeof firstPage.data) => {
    for (const c of rows) {
      if (
        c.current_deal?.status === "active" ||
        c.current_deal?.status === "scheduled"
      ) {
        activeDealCount += 1;
        activeDeals.push({ userId: c.id, dealId: c.current_deal.id });
      }
      if (c.active_session_id !== null) {
        liveCount += 1;
      }
      if (c.total_deals_count > 0) {
        fillCreatorCount += 1;
      }
    }
  };
  tallyPage(firstPage.data);
  for (const pg of remainingPages) tallyPage(pg.data);

  // "Converted" — sum the MINTED `creator_fill_conversion` payout
  // vouchers across every active/scheduled deal (§2 of the creator
  // model). Single Main-DB round-trip grouped by deal. This is the real
  // money converted into payout vouchers, NOT the backend deal's
  // `withdraw_cap_used_usd` cap-consumption counter (admin-mutable, per
  // deal-version — the wrong source for a minted-voucher figure). A
  // failure leaves the total at 0 so the tile drops to "—" rather than
  // showing a wrong number.
  //
  // "Withdrawn from converted" runs in parallel — a second Main-DB
  // round-trip over the SAME voucher set (vouchers join
  // card_withdrawal_requests), grouped by deal. Sharing the source
  // guarantees `withdrawn ≤ converted`. A failure leaves the breakdown
  // at 0 so the tile still shows the converted total.
  const [convertedByUser, withdrawnByUser] = await Promise.all([
    getConvertedFromVouchersByDeal(activeDeals).catch((err) => {
      console.error(
        "[creators-stats] converted-from-vouchers query failed (tile renders 0):",
        err,
      );
      return new Map<string, number>();
    }),
    getWithdrawnFromConvertedByDeal(activeDeals).catch((err) => {
      console.error(
        "[creators-stats] withdrawn-from-converted query failed (sub-line hidden):",
        err,
      );
      return new Map<
        string,
        { withdrawnUsd: number; withdrawPendingUsd: number }
      >();
    }),
  ]);
  let convertedTotal = 0;
  for (const value of convertedByUser.values()) convertedTotal += value;
  let withdrawnFromConvertedTotal = 0;
  let withdrawPendingFromConvertedTotal = 0;
  for (const row of withdrawnByUser.values()) {
    withdrawnFromConvertedTotal += row.withdrawnUsd;
    withdrawPendingFromConvertedTotal += row.withdrawPendingUsd;
  }

  return {
    // `total` from the backend is the absolute count (not affected
    // by per-page paging). Use it directly so the tile stays
    // accurate even if MAX_PAGES caps the count traversal.
    totalCreators: firstPage.total,
    fillCreatorCount,
    activeDealCount,
    liveCount,
    convertedTotal,
    withdrawnFromConvertedTotal,
    withdrawPendingFromConvertedTotal,
  };
}
