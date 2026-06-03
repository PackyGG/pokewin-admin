import "server-only";

import { unstable_cache } from "next/cache";

import { creatorsApi, type CreatorSessionResponse } from "@/lib/backend-api";
import { withTiming } from "@/lib/observability/query-timings";
import { CREATOR_COST_CACHE_TTL_SECONDS } from "./_cost-cache";

/**
 * Per-creator HOUSE-FUNDED tips & sponsor cost — the fill-program balance
 * this creator handed out to their community as tips / battle sponsors
 * (§3 of the creator model: the separate, system-generated tips/sponsor
 * pool the house funds so creators can reward viewers).
 *
 * ─── WHY THIS EXISTS (the gap it closes) ─────────────────────────────
 *
 * The creator detail page's "House cost to this creator" panel was
 * MULTIPLIER-centric: it only surfaced leaderboard prizes + multiplier
 * payouts + multiplier fill. For a normal FILL-deal creator (the common
 * case) the multiplier rows are empty, AND the panel was MISSING the
 * house-funded tips/sponsors the creator spent out of their fill — a
 * real house outflow tied to this creator. This query supplies that
 * missing cost so the panel reflects fill-deal creators correctly.
 *
 * ─── WHY SESSION-DERIVED, NOT LEDGER-DERIVED (the undercount fix) ─────
 *
 * This previously summed `ledger_transactions` of type
 * `creator_fill_spend_tip` / `creator_fill_spend_battle`. That under-counted
 * the real total: the panel showed a single session's spend (e.g. $5) for a
 * creator who actually ran 2 sessions × $5 = $10. The root cause is that the
 * `creator_fill_spend_*` ledger enum members are not (fully) present on the
 * environments backing this panel — on the stale snapshot the ledger `type`
 * enum carries ZERO `creator_fill_*` members at all, and on prod they may be
 * only partially populated, so the ledger Σ silently drops the missing rows
 * and degrades to a lower bound. There is no reliable, complete ledger source
 * for these spends here.
 *
 * The AUTHORITATIVE, complete source is the backend's per-session spend
 * counters: each `CreatorSessionResponse` carries
 * `tips_spent_this_session_usd` + `sponsorship_spent_this_session_usd` (the
 * exact figures the sessions list renders per row). Summing those across ALL
 * of the creator's sessions is the true total the house spent, and — because
 * it reads the very same data the per-session rows show — the panel total is
 * guaranteed to reconcile with the sum of the per-session figures. So we sum
 * the sessions, not the ledger.
 *
 * The amount leaves the house's system-generated funds, so this Σ is the
 * realized house cost of the creator's giveaways. House cost → the caller
 * renders it rose.
 *
 * ─── NO DOUBLE-COUNT ─────────────────────────────────────────────────
 *
 * Tips/sponsor spent out of fill is a DISTINCT flow from the fill
 * ACTIVATION/refund lifecycle and the end-session CONVERSION voucher, so
 * this never overlaps the leaderboard, the multiplier `netFill`, or the
 * `creator_fill_conversion` payout cost on the panel. (On the WEEKLY fill
 * program the multiplier `netFill` is 0 — those deals aren't in the
 * multiplier API — so these spends are not captured anywhere else.)
 *
 * ─── RESILIENCE ──────────────────────────────────────────────────────
 *
 * The backend pages sessions; we walk every page so a creator with many
 * sessions is fully summed, with a hard page cap as a runaway guard. The
 * caller wraps this in `safeQuery → { costUsd: 0, eventCount: 0 }`, so a
 * backend outage degrades the line to 0 rather than blanking the panel; a
 * 404 (user isn't a creator on the backend) likewise yields an empty list →
 * 0. The creator id is forwarded to the backend as a path param (encoded by
 * the API client) — never concatenated into SQL.
 */
export type CreatorTipsSponsorCost = {
  /** Σ (tips + sponsorship) spent across ALL of this creator's sessions (lifetime). */
  costUsd: number;
  /** Number of sessions that recorded any tip/sponsor spend — context for the metric. */
  eventCount: number;
};

// Backend sessions list page size. Matched to a comfortable upper bound for
// a single round-trip; we page until exhausted.
const SESSIONS_PAGE_LIMIT = 100;
// Runaway guard: never walk more than this many pages (100 × 100 = 10k
// sessions) so a pathological count can't pin the request. In practice a
// creator has far fewer sessions than this.
const MAX_SESSION_PAGES = 100;

function sessionCommunitySpendUsd(session: CreatorSessionResponse): number {
  const tips = Number(session.tips_spent_this_session_usd);
  const sponsor = Number(session.sponsorship_spent_this_session_usd);
  return (
    (Number.isFinite(tips) ? tips : 0) +
    (Number.isFinite(sponsor) ? sponsor : 0)
  );
}

async function computeCreatorTipsSponsorCost(
  creatorUserId: string,
): Promise<CreatorTipsSponsorCost> {
  return withTiming("creators.netPnl.tipsSponsorCost", async () => {
    let costUsd = 0;
    let eventCount = 0;
    let offset = 0;

    for (let page = 0; page < MAX_SESSION_PAGES; page++) {
      const slice = await creatorsApi.listSessions(creatorUserId, {
        limit: SESSIONS_PAGE_LIMIT,
        offset,
      });

      for (const session of slice.data) {
        const spend = sessionCommunitySpendUsd(session);
        if (spend > 0) {
          costUsd += spend;
          eventCount += 1;
        }
      }

      offset += slice.data.length;
      // Stop once we've consumed every session (short page or reached the
      // reported total). `slice.data.length === 0` guards an empty trailing
      // page; `offset >= slice.total` is the normal exhaustion condition.
      if (slice.data.length === 0 || offset >= slice.total) break;
    }

    return { costUsd, eventCount };
  });
}

// Cached per creator id — the per-session spend Σ is a lifetime aggregate;
// a few-minutes TTL stops repeat loads / "Refresh to retry" from re-walking
// every session page on the backend (see `_cost-cache.ts`).
const cachedCreatorTipsSponsorCost = unstable_cache(
  computeCreatorTipsSponsorCost,
  ["creators-detail-tips-sponsor-cost-v2-sessions"],
  { revalidate: CREATOR_COST_CACHE_TTL_SECONDS },
);

export async function getCreatorTipsSponsorCost(
  creatorUserId: string,
): Promise<CreatorTipsSponsorCost> {
  return cachedCreatorTipsSponsorCost(creatorUserId);
}
