import "server-only";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";

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
 * ─── WHAT IT SUMS ────────────────────────────────────────────────────
 *
 *   Σ |amount| over `ledger_transactions` where
 *     type ∈ { creator_fill_spend_tip, creator_fill_spend_battle }
 *     AND user_id = <this creator>
 *     AND status = 'completed'
 *
 * These two ledger types are the spend legs of the house-funded
 * tips/sponsor pool — a tip the creator gifted a user
 * (`creator_fill_spend_tip`) or balance they sponsored for a battle
 * (`creator_fill_spend_battle`). The amount leaves the house's
 * system-generated funds, so summing the absolute value is the realized
 * house cost of the creator's giveaways. House cost → the caller renders
 * it rose.
 *
 * ─── NO DOUBLE-COUNT ─────────────────────────────────────────────────
 *
 * Distinct ledger types from the fill ACTIVATION/refund lifecycle and the
 * end-session CONVERSION voucher, so this never overlaps the leaderboard,
 * the multiplier `netFill`, or the `creator_fill_conversion` payout cost.
 * (On the WEEKLY fill program the multiplier `netFill` is 0 — those deals
 * aren't in the multiplier API — so these spends are not captured anywhere
 * else on the panel.)
 *
 * ─── ENUM SAFETY (CRITICAL) ──────────────────────────────────────────
 *
 * The comparison is on `type::text` against STRING literals, NOT enum
 * literals: the production `ledger_transactions.type` enum may not yet
 * carry the `creator_fill_spend_tip` / `creator_fill_spend_battle`
 * members, and Postgres throws `invalid input value for enum` the moment
 * an enum literal that isn't in the type appears in the query text — even
 * inside a `CASE`/`IN` that would never match a row. Casting the column to
 * text and comparing against plain strings sidesteps the enum entirely, so
 * an environment whose enum lacks these values returns 0 instead of
 * throwing. The caller additionally wraps this in `safeQuery → 0` so any
 * other failure degrades the row to 0 rather than blanking the panel.
 *
 * The creator id is passed as a BIND PARAMETER ($1) — never concatenated.
 */
export type CreatorTipsSponsorCost = {
  /** Σ |amount| over the house-funded tip + battle-sponsor spend legs (lifetime). */
  costUsd: number;
  /** Number of tip/sponsor spend events — context for the metric. */
  eventCount: number;
};

export async function getCreatorTipsSponsorCost(
  creatorUserId: string,
): Promise<CreatorTipsSponsorCost> {
  return withTiming("creators.netPnl.tipsSponsorCost", async () => {
    const db = await getDb();

    type Row = { cost: string | null; event_count: string | null };

    const rows = await db.$queryRawUnsafe<Row[]>(
      `SELECT
          COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS cost,
          COUNT(*)::text AS event_count
        FROM ledger_transactions lt
        WHERE lt.user_id = $1
          AND lt.status::text = 'completed'
          AND lt.type::text IN ('creator_fill_spend_tip', 'creator_fill_spend_battle')`,
      creatorUserId,
    );

    return {
      costUsd: toNumber(rows[0]?.cost),
      eventCount: Number(rows[0]?.event_count ?? 0) || 0,
    };
  });
}
