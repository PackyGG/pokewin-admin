import "server-only";

import { unstable_cache } from "next/cache";

import { creatorsApi } from "@/lib/backend-api";
import { getLeaderboard2wkCostByUser } from "../../../../(admin)/creators/_queries/leaderboard-cost";

/**
 * Full DEAL VALUE per creator — for the Hub roster's "biggest / smallest
 * deal" sort + the per-row deal-value chip.
 *
 * The owner's spec (plan, 2026-06-06):
 *   "biggest / smallest deal" ranks by the FULL deal value/cost, not a
 *   single field — i.e. withdrawal caps + leaderboard funding (× leaderboard
 *   % house share) + tips + sponsorship combined.
 *
 * Composition (each leg reuses EXISTING data, never invented):
 *   • capUsd        — the active/scheduled deal's `total_withdraw_cap_usd`
 *                     (the worst-case withdrawal ceiling). Same field the
 *                     legacy card's "Cap" chip + "2-Week Max Cost · Deal"
 *                     row already render. null cap → 0 (uncapped deals add
 *                     nothing finite to the ranking).
 *   • leaderboardUsd— the creator's upcoming sponsored-weighted leaderboard
 *                     house cost from `getLeaderboard2wkCostByUser` — the
 *                     prize pool already multiplied by the house share %
 *                     (`admin_leaderboard_sponsorship`). This is the SAME
 *                     value the legacy roster surfaces as the LB leg, so the
 *                     house-% weighting the plan demands is applied here by
 *                     construction.
 *   • tipSponsorUsd — the deal's house-funded per-stream tip + sponsorship
 *                     ALLOWANCE (`max_tip_per_stream_usd` +
 *                     `max_sponsorship_per_stream_usd`). These are the
 *                     deal's stated per-stream house-funded ceilings (the
 *                     tip/sponsor allowance the owner says MUST be counted).
 *
 * dealValueUsd = capUsd + leaderboardUsd + tipSponsorUsd.
 *
 * All legs are a HOUSE cost ceiling (rose, house-POV). This is a worst-case
 * deal SIZE used to rank the roster — not money already paid.
 *
 * Resilience: per-creator deal fetches use `Promise.allSettled` so one
 * creator's failed deal lookup never blanks the rest; a creator whose fetch
 * fails (or who has no active/scheduled deal) is simply absent from the map
 * and the caller treats its deal value as 0 for the ranking + renders "—".
 *
 * Active-timeframe-safe: the leaderboard walk is one shared fetch (not
 * per-creator), and the deal fetches only cover the deals the CALLER passes
 * in (the page passes only active/scheduled deals on the current roster).
 */

export type CreatorDealValue = {
  /** Active/scheduled deal withdrawal cap (USD); 0 when uncapped/absent. */
  capUsd: number;
  /** Upcoming leaderboard house cost (USD), already × house share %. */
  leaderboardUsd: number;
  /** Per-stream house-funded tip + sponsorship allowance (USD). */
  tipSponsorUsd: number;
  /** capUsd + leaderboardUsd + tipSponsorUsd — the full deal value (rose). */
  dealValueUsd: number;
};

function toFiniteNumber(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Per-deal cap + tip/sponsor allowance legs, serializable for the cache. */
type DealCapTip = { capUsd: number; tipSponsorUsd: number };

/**
 * The backend `getDeal` fan-out behind {@link getDealValueByUser}, wrapped
 * in `unstable_cache` (5-min revalidate) keyed on the requested
 * (userId, dealId) pairs so re-renders / tab flips / period switches that
 * surface the same active deals don't re-fan the per-deal backend
 * round-trips. Mirrors the sibling `cachedDealCapEntries` in the admin
 * deal-cap-by-user.ts (same TTL + tag), differing only in the legs pulled
 * (cap + per-stream tip/sponsor allowance instead of cap + used). Backend-
 * only (creatorsApi.getDeal), so it resolves to the prod env inside the
 * cache scope and needs no env key. The (userId, dealId) pairs are folded
 * into the key parts; serializable entries are returned (an
 * `unstable_cache` callback can't store a `Map`) and the caller rebuilds
 * the Maps.
 */
const cachedDealCapTipEntries = (deals: { userId: string; dealId: string }[]) =>
  unstable_cache(
    async (): Promise<[string, DealCapTip][]> => {
      const settled = await Promise.allSettled(
        deals.map((d) => creatorsApi.getDeal(d.userId, d.dealId)),
      );
      const entries: [string, DealCapTip][] = [];
      settled.forEach((outcome, i) => {
        const userId = deals[i].userId;
        if (outcome.status === "fulfilled") {
          const deal = outcome.value;
          entries.push([
            userId,
            {
              capUsd: toFiniteNumber(deal.total_withdraw_cap_usd),
              // Per-stream house-funded tip + sponsorship allowance.
              tipSponsorUsd:
                toFiniteNumber(deal.max_tip_per_stream_usd) +
                toFiniteNumber(deal.max_sponsorship_per_stream_usd),
            },
          ]);
        } else {
          console.error(
            `[creator-hub roster] getDeal failed for creator ${userId} (deal value renders "—"):`,
            outcome.reason,
          );
        }
      });
      return entries;
    },
    ["creators-deal-cap-tip-v1", ...deals.map((d) => `${d.userId}:${d.dealId}`)],
    { revalidate: 300, tags: ["creators-deal-cap"] },
  );

/**
 * Resolve the full deal value for a set of creators' active/scheduled deals.
 *
 * @param deals  `{ userId, dealId }` for each creator whose CURRENT deal is
 *               active or scheduled (the caller filters this from the roster
 *               — co-creators / past-deal creators are excluded upstream).
 * @returns      Map keyed by `userId`. Creators absent from the map have no
 *               finite deal value (no active deal, or the lookup failed).
 */
export async function getDealValueByUser(
  deals: { userId: string; dealId: string }[],
): Promise<Map<string, CreatorDealValue>> {
  const result = new Map<string, CreatorDealValue>();

  // Leaderboard house cost is keyed by the owning creator and is a single
  // shared walk regardless of how many deals we resolve — fetch it once.
  // Best-effort: a failure leaves the LB leg at 0 (the cap + tip/sponsor
  // legs still rank) rather than blanking the whole sort.
  const lbByUser = await getLeaderboard2wkCostByUser().catch((err) => {
    console.error(
      "[creator-hub roster] leaderboard cost fetch failed (deal value drops the LB leg):",
      err,
    );
    return new Map<string, { costUsd: number; effectivePct: number }>();
  });

  // Per-deal cap + tip/sponsor allowance — one backend round-trip per
  // active/scheduled deal, all in flight together (allSettled so one dead
  // leg can't sink the rest), and cross-request cached so re-renders that
  // surface the same deals don't re-fan the backend. The pairs are sorted
  // so the cache key is stable regardless of roster order — the rebuilt
  // Maps are keyed by userId (order-independent), so a sorted key lifts the
  // hit rate without changing any output.
  const sortedDeals = [...deals].sort((a, b) =>
    a.userId === b.userId
      ? a.dealId.localeCompare(b.dealId)
      : a.userId.localeCompare(b.userId),
  );
  const capTipEntries =
    sortedDeals.length === 0
      ? []
      : await cachedDealCapTipEntries(sortedDeals)();

  const capByUser = new Map<string, number>();
  const tipSponsorByUser = new Map<string, number>();
  for (const [userId, legs] of capTipEntries) {
    capByUser.set(userId, legs.capUsd);
    tipSponsorByUser.set(userId, legs.tipSponsorUsd);
  }

  // Union of every creator that has ANY contributing leg (a deal we
  // resolved, OR an upcoming leaderboard cost) — so a creator with only a
  // leaderboard and no resolvable deal still ranks on their LB cost.
  const userIds = new Set<string>([
    ...capByUser.keys(),
    ...tipSponsorByUser.keys(),
    ...lbByUser.keys(),
  ]);

  for (const userId of userIds) {
    const capUsd = capByUser.get(userId) ?? 0;
    const tipSponsorUsd = tipSponsorByUser.get(userId) ?? 0;
    const leaderboardUsd = lbByUser.get(userId)?.costUsd ?? 0;
    const dealValueUsd = capUsd + leaderboardUsd + tipSponsorUsd;
    // Skip a pure-zero entry so the caller's "—" fallback stays meaningful
    // (a creator with no cap, no LB, no allowance contributes nothing).
    if (dealValueUsd <= 0) continue;
    result.set(userId, { capUsd, leaderboardUsd, tipSponsorUsd, dealValueUsd });
  }

  return result;
}
