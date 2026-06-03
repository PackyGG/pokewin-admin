import "server-only";

import { unstable_cache } from "next/cache";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { CREATOR_COST_CACHE_TTL_SECONDS } from "./_cost-cache";

/**
 * Per-creator FILL-DEAL payout cost — the lifetime value of every
 * end-of-session payout voucher this creator minted under the WEEKLY
 * FILL program (`vouchers.origin = 'creator_fill_conversion'`, §2 of the
 * creator model: the "stream payout voucher").
 *
 * ─── WHY THIS EXISTS (the gap it closes) ─────────────────────────────
 *
 * The creator detail page's cost breakdown (`getCreatorTotalCost`) was
 * built ONLY from the backend MULTIPLIER-deal records
 * (`multiplierDealsApi` → `withdrawable_voucher_usd` +
 * `platform_funding_usd − fill_refunded_usd`). Multiplier payouts mint
 * `creator_multiplier_payout` vouchers — a DISTINCT `voucher_origin` from
 * the weekly fill program's `creator_fill_conversion`. So a creator on a
 * WEEKLY FILL deal (the common case — it's what /creators's "Converted"
 * KPI counts) had ZERO fill-payout cost on their detail page, which
 * OVERSTATED their Net Creator PnL (house profit) by the entire
 * fill-conversion payout.
 *
 * This reads the SAME canonical source the /creators "Converted" KPI uses
 * (`getConvertedFromVouchersTotal` — lifetime, all creators), just scoped
 * to ONE creator across ALL their deals (also `creator_fill_conversion`,
 * no deal filter). So the detail-page cost line and the list KPI agree on
 * what a fill-deal payout is.
 *
 * ─── NO DOUBLE-COUNT ─────────────────────────────────────────────────
 *
 *   • `creator_fill_conversion` (this query) and `creator_multiplier_payout`
 *     (`getCreatorMultiplierCost.payoutUsd`) are disjoint `voucher_origin`
 *     enum members, so summing both never counts the same voucher twice.
 *   • The fill ACTIVATION/refund lifecycle the multiplier `netFill`
 *     captures (`creator_fill_activation − creator_fill_refund`) is the
 *     fill GRANTED (a residual escrow flow), NOT the converted payout
 *     voucher. The conversion voucher is the realized house payout — a
 *     separate, real cost. Counting both the net-fill granted AND the
 *     conversion payout is correct: the granted fill that wasn't refunded
 *     is house spend, and the converted voucher is the cash-outable payout
 *     it turned into. (For the WEEKLY fill program the multiplier
 *     `netFill` is 0 — those deals aren't in the multiplier API — so for a
 *     fill-only creator this term is the whole fill-program cost.)
 *
 * House cost → the caller renders it rose.
 *
 * Best-effort by design: the caller (`getCreatorTotalCost`) catches a
 * failure and degrades the bucket to 0 (flipping the cost to a lower
 * bound), exactly like the multiplier / leaderboard sub-fetches.
 *
 * The creator id is passed as a BIND PARAMETER ($1) — never concatenated.
 */
export type CreatorFillConversionCost = {
  /** Σ `vouchers.value` over `origin = 'creator_fill_conversion'` for this user (lifetime). */
  payoutUsd: number;
  /** Number of conversion vouchers minted — context for the metric. */
  voucherCount: number;
};

async function computeCreatorFillConversionCost(
  creatorUserId: string,
): Promise<CreatorFillConversionCost> {
  return withTiming("creators.netPnl.fillConversionCost", async () => {
    const db = await getDb();

    type Row = { payout: string | null; voucher_count: string | null };

    const rows = await db.$queryRawUnsafe<Row[]>(
      `SELECT
          COALESCE(SUM(v.value::numeric), 0)::text AS payout,
          COUNT(*)::text AS voucher_count
        FROM vouchers v
        WHERE v.user_id = $1
          AND v.origin = 'creator_fill_conversion'`,
      creatorUserId,
    );

    return {
      payoutUsd: toNumber(rows[0]?.payout),
      voucherCount: Number(rows[0]?.voucher_count ?? 0) || 0,
    };
  });
}

// Cached per creator id — the conversion-voucher Σ is a lifetime aggregate
// that barely moves, so a few-minutes TTL stops repeat loads / "Refresh to
// retry" presses from re-scanning. `getDb()` inside the cache → prod (see
// `_cost-cache.ts`). The creator id is the cache key (passed as the fn arg
// so unstable_cache folds it into the key).
const cachedCreatorFillConversionCost = unstable_cache(
  computeCreatorFillConversionCost,
  ["creators-detail-fill-conversion-cost-v1"],
  { revalidate: CREATOR_COST_CACHE_TTL_SECONDS },
);

export async function getCreatorFillConversionCost(
  creatorUserId: string,
): Promise<CreatorFillConversionCost> {
  return cachedCreatorFillConversionCost(creatorUserId);
}
