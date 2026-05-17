import "server-only";

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
export async function getDealCapInfoByUser(
  deals: { userId: string; dealId: string }[],
): Promise<Map<string, DealCapInfo>> {
  const result = new Map<string, DealCapInfo>();
  if (deals.length === 0) return result;

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
      result.set(deals[i].userId, {
        usedUsd: Number.isFinite(used) ? used : 0,
        totalCapUsd:
          total != null && Number.isFinite(total) ? total : null,
      });
    } else {
      console.error(
        `[deal-cap-by-user] getDeal failed for creator ${deals[i].userId} (rendering "—"):`,
        outcome.reason,
      );
    }
  });
  return result;
}
