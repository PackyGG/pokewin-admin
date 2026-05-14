import "server-only";

import { creatorsApi } from "@/lib/backend-api";
import {
  getAllCreatorsLifetimePnl,
  type AllCreatorsLifetimePnl,
} from "./all-creators-lifetime-pnl";

export type CreatorsGlobalStats = {
  /** Total creator accounts on the platform. */
  totalCreators: number;
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
   * Combined House P&L across EVERY creator's referred-user pool —
   * lifetime, balance-sheet snapshot. Same formula as the per-creator
   * hero tile on /creators/[id], but the pool is the UNION of every
   * creator's referrals (deduplicated so a user referred by multiple
   * creators only counts once). Null on query failure so the KPI
   * tile falls back to "—".
   */
  lifetimePnl: AllCreatorsLifetimePnl | null;
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
  // total we can request the remaining pages in parallel. The
  // lifetime PnL query is independent — kicked off in parallel with
  // the first page so the round-trips overlap.
  const [firstPage, lifetimePnl] = await Promise.all([
    creatorsApi.list({
      // No search filter — these are global counts. If the user types
      // in the search box, the KPI tiles should stay stable.
      offset: 0,
      limit: PAGE_SIZE,
    }),
    // Lifetime PnL hits the main game DB (not the creators backend),
    // so it runs alongside the backend paginated walk below. Best-
    // effort: a query failure here returns null and the KPI tile
    // falls back to "—" rather than crashing the whole page.
    getAllCreatorsLifetimePnl().catch((err) => {
      console.error(
        "[creators-stats] lifetime PnL query failed (tile will render '—'):",
        err,
      );
      return null;
    }),
  ]);

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

  // Count predicates across every page we fetched.
  let activeDealCount = 0;
  let liveCount = 0;
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
    }
  };
  tallyPage(firstPage.data);
  for (const pg of remainingPages) tallyPage(pg.data);

  return {
    // `total` from the backend is the absolute count (not affected
    // by per-page paging). Use it directly so the tile stays
    // accurate even if MAX_PAGES caps the count traversal.
    totalCreators: firstPage.total,
    activeDealCount,
    liveCount,
    lifetimePnl,
  };
}
