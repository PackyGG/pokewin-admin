import "server-only";

import { unstable_cache } from "next/cache";

import { creatorsApi } from "@/lib/backend-api";
import { getConvertedFromVouchersTotal } from "./converted-from-vouchers-total";
import { getWithdrawnFromConvertedTotal } from "./withdrawn-from-converted-total";

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
   * across EVERY creator ever (LIFETIME, no active/scheduled-deal
   * filter): how much stream earnings have ever been converted into
   * payout vouchers (§2 of the creator model). Sourced from the Main-DB
   * `vouchers` table — the SAME voucher set the withdrawn sub-line reads
   * — NOT the backend deal's `withdraw_cap_used_usd` cap-consumption
   * counter (admin-mutable and per deal-version, the wrong source for a
   * minted-voucher figure). Best-effort — a query failure leaves this at
   * 0 rather than crashing the tile.
   */
  convertedTotal: number;
  /**
   * Of `convertedTotal` (payout vouchers minted from conversion), how
   * much has actually left the platform via a completed
   * card_withdrawal_requests row — LIFETIME, across every creator (same
   * unscoped lens as `convertedTotal`). Reads the SAME
   * `creator_fill_conversion` voucher set as `convertedTotal`, so
   * `withdrawn ≤ converted` holds by construction.
   */
  withdrawnFromConvertedTotal: number;
  /**
   * Same scope as `withdrawnFromConvertedTotal` (lifetime / all
   * creators), but for in-flight withdraw requests (pending / processing
   * / shipped) — i.e. already requested but not yet terminal.
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

type CreatorGlobalCounts = {
  totalCreators: number;
  fillCreatorCount: number;
  activeDealCount: number;
  liveCount: number;
};

/**
 * The backend creator-pool walk + tally behind the global KPI strip,
 * wrapped in `unstable_cache` (5-min revalidate) so the full paginated
 * roster walk runs at most once per 5 min per cold slot instead of on
 * every /creators render. Backend-only (creatorsApi.list resolves to the
 * prod env inside the cache scope, same convention as the sibling
 * fill-creator-count walk), so no env key is needed. The converted /
 * withdrawn Main-DB aggregates are env-dependent + separately catch-
 * wrapped, so they stay OUTSIDE this cache.
 */
const cachedCreatorGlobalCounts = unstable_cache(
  async (): Promise<CreatorGlobalCounts> => {
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

    // Count predicates across every page we fetched. The "Converted /
    // withdrawn" totals no longer need a per-deal id set — they're now
    // lifetime, all-creators aggregates over the `creator_fill_conversion`
    // voucher origin (owner scope decision), so the active/scheduled-deal
    // walk below only feeds the `activeDealCount` tile.
    let activeDealCount = 0;
    let liveCount = 0;
    // Creators with ≥1 fill (weekly) deal — total_deals_count is the
    // backend's lifetime fill-deal count for the creator.
    let fillCreatorCount = 0;
    const tallyPage = (rows: typeof firstPage.data) => {
      for (const c of rows) {
        if (
          c.current_deal?.status === "active" ||
          c.current_deal?.status === "scheduled"
        ) {
          activeDealCount += 1;
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

    return {
      // `total` from the backend is the absolute count (not affected
      // by per-page paging). Use it directly so the tile stays
      // accurate even if MAX_PAGES caps the count traversal.
      totalCreators: firstPage.total,
      fillCreatorCount,
      activeDealCount,
      liveCount,
    };
  },
  ["creators-global-counts-v1"],
  { revalidate: 300, tags: ["creators-global-stats"] },
);

export async function getCreatorsGlobalStats(): Promise<CreatorsGlobalStats> {
  const counts = await cachedCreatorGlobalCounts();

  // "Converted" — sum the MINTED `creator_fill_conversion` payout
  // vouchers across EVERY creator ever (LIFETIME, no active/scheduled-
  // deal filter — owner scope decision; §2 of the creator model). Single
  // Main-DB whole-table aggregate over the fixed origin. This is the real
  // money converted into payout vouchers, NOT the backend deal's
  // `withdraw_cap_used_usd` cap-consumption counter (admin-mutable, per
  // deal-version — the wrong source for a minted-voucher figure). A
  // failure leaves the total at 0 so the tile drops to "—" rather than
  // showing a wrong number.
  //
  // "Withdrawn from converted" runs in parallel — a second Main-DB
  // round-trip over the SAME voucher set (vouchers join
  // card_withdrawal_requests), same lifetime/all-creators scope. Sharing
  // the source guarantees `withdrawn ≤ converted`. A failure leaves the
  // breakdown at 0 so the tile still shows the converted total.
  const [convertedTotalResult, withdrawnTotalResult] = await Promise.all([
    getConvertedFromVouchersTotal().catch((err) => {
      console.error(
        "[creators-stats] converted-from-vouchers total query failed (tile renders 0):",
        err,
      );
      return 0;
    }),
    getWithdrawnFromConvertedTotal().catch((err) => {
      console.error(
        "[creators-stats] withdrawn-from-converted total query failed (sub-line hidden):",
        err,
      );
      return { withdrawnUsd: 0, withdrawPendingUsd: 0 };
    }),
  ]);
  const convertedTotal = convertedTotalResult;
  const withdrawnFromConvertedTotal = withdrawnTotalResult.withdrawnUsd;
  const withdrawPendingFromConvertedTotal =
    withdrawnTotalResult.withdrawPendingUsd;

  return {
    totalCreators: counts.totalCreators,
    fillCreatorCount: counts.fillCreatorCount,
    activeDealCount: counts.activeDealCount,
    liveCount: counts.liveCount,
    convertedTotal,
    withdrawnFromConvertedTotal,
    withdrawPendingFromConvertedTotal,
  };
}
