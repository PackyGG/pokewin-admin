import "server-only";

import { unstable_cache } from "next/cache";

import { creatorsApi } from "@/lib/backend-api";

export type DealCapInfo = {
  /**
   * `withdraw_cap_used_usd` — how much the deal has already converted
   * into payout vouchers against its withdraw cap. Surfaced as the
   * per-creator "Converted" stat.
   */
  usedUsd: number;
  /**
   * `total_withdraw_cap_usd` — the deal's withdrawal ceiling: the most
   * the creator can ever withdraw on it. null when the deal is uncapped
   * (the backend returns null). This is the worst-case house cost the
   * deal can incur — surfaced as the card's "Cap" chip and the deal
   * side of the "2-Week Max Cost" row.
   */
  totalCapUsd: number | null;
};

/**
 * Per-creator deal cap info, resolved from the backend creators API.
 *
 * The lightweight `current_deal` object on the creators-list response
 * does NOT carry the withdraw-cap fields — only the full
 * `CreatorDealResponse` (the single-deal endpoint) does. So this helper
 * fetches each creator's current deal by id and pulls
 * `withdraw_cap_used_usd` + `total_withdraw_cap_usd` out — the same
 * source the creator-detail deal table renders.
 *
 * `Promise.allSettled` — one creator's failed deal fetch must not blank
 * out the rest. A creator whose fetch fails is simply absent from the
 * returned map, and callers fall back to `null` ("—").
 *
 * Callers decide WHICH deals to pass in (e.g. only active/scheduled
 * ones) — this helper just resolves whatever id pairs it's given.
 */
/**
 * The backend `getDeal` fan-out behind {@link getDealCapInfoByUser},
 * wrapped in `unstable_cache` (5-min revalidate) keyed on the requested
 * (userId, dealId) pairs so re-renders / tab flips that surface the same
 * visible deals don't re-fan the per-deal backend round-trips. Backend-
 * only (creatorsApi.getDeal), so it resolves to the prod env inside the
 * cache scope (sibling fill-creator-count convention) and needs no env
 * key. The (userId, dealId) pairs are folded into the key parts — a
 * factory closure mirroring how all-creators-net-pnl.ts threads its
 * varying inputs into the key. Returns serializable entries (an
 * `unstable_cache` callback can't store a `Map`); the public helper
 * rebuilds the Map.
 */
const cachedDealCapEntries = (deals: { userId: string; dealId: string }[]) =>
  unstable_cache(
    async (): Promise<[string, DealCapInfo][]> => {
      const entries: [string, DealCapInfo][] = [];
      const settled = await Promise.allSettled(
        deals.map((d) => creatorsApi.getDeal(d.userId, d.dealId)),
      );
      settled.forEach((outcome, i) => {
        if (outcome.status === "fulfilled") {
          const used = Number(outcome.value.withdraw_cap_used_usd);
          // total_withdraw_cap_usd is `string | null` — null means an
          // uncapped deal (no finite worst case → totalCapUsd stays null).
          const rawTotal = outcome.value.total_withdraw_cap_usd;
          const total = rawTotal == null ? null : Number(rawTotal);
          entries.push([
            deals[i].userId,
            {
              usedUsd: Number.isFinite(used) ? used : 0,
              totalCapUsd:
                total != null && Number.isFinite(total) ? total : null,
            },
          ]);
        } else {
          console.error(
            `[deal-cap-by-user] getDeal failed for creator ${deals[i].userId} (rendering "—"):`,
            outcome.reason,
          );
        }
      });
      return entries;
    },
    ["creators-deal-cap-v1", ...deals.map((d) => `${d.userId}:${d.dealId}`)],
    { revalidate: 300, tags: ["creators-deal-cap"] },
  );

export async function getDealCapInfoByUser(
  deals: { userId: string; dealId: string }[],
): Promise<Map<string, DealCapInfo>> {
  if (deals.length === 0) return new Map();

  // Sort the pairs so the cache key is stable regardless of roster order
  // — the result Map is keyed by userId (order-independent), so a sorted
  // key lifts the hit rate across renders that surface the same deals in a
  // different order without changing any output.
  const sorted = [...deals].sort((a, b) =>
    a.userId === b.userId
      ? a.dealId.localeCompare(b.dealId)
      : a.userId.localeCompare(b.userId),
  );
  return new Map(await cachedDealCapEntries(sorted)());
}
