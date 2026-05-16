import "server-only";

import { creatorsApi } from "@/lib/backend-api";

/**
 * Per-creator "Converted" amount — how much a creator's deal has
 * withdrawn against its withdraw cap (`withdraw_cap_used_usd`).
 *
 * The lightweight `current_deal` object on the creators-list response
 * does NOT carry the withdraw-cap fields — only the full
 * `CreatorDealResponse` (the single-deal endpoint) does. So this helper
 * fetches each creator's current deal by id and pulls
 * `withdraw_cap_used_usd` out.
 *
 * `Promise.allSettled` — one creator's failed deal fetch must not blank
 * out the rest. A creator whose fetch fails is simply absent from the
 * returned map, and callers fall back to `null` ("—").
 *
 * Callers decide WHICH deals to pass in (e.g. only active/scheduled
 * ones) — this helper just resolves whatever id pairs it's given.
 */
export async function getDealCapUsageByUser(
  deals: { userId: string; dealId: string }[],
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (deals.length === 0) return result;

  const settled = await Promise.allSettled(
    deals.map((d) => creatorsApi.getDeal(d.userId, d.dealId)),
  );
  settled.forEach((outcome, i) => {
    if (outcome.status === "fulfilled") {
      const used = Number(outcome.value.withdraw_cap_used_usd);
      result.set(deals[i].userId, Number.isFinite(used) ? used : 0);
    } else {
      console.error(
        `[deal-cap-by-user] getDeal failed for creator ${deals[i].userId} (rendering "—"):`,
        outcome.reason,
      );
    }
  });
  return result;
}
