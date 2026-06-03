import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

// ─── Lifetime promo-code money stats for the /promo-codes hero strip ──
//
// Two overall (no-timeframe) headline numbers describing the promo-code
// programme's money flow, House-POV:
//
//   1. claimedGivenOut — REALIZED house cost: the total promo value that
//      actually reached users. Sourced from the IMMUTABLE ledger
//      (`ledger_transactions WHERE type = 'promo_code_redeemed'`), summed
//      as ABS(amount) the same way every other reward-cost query in the
//      codebase sums redeemed-credit legs (dashboard-reward-costs-today,
//      rewards-analytics, …).
//
//      CRITICAL — this is computed with NO JOIN to `promo_codes` /
//      `promo_code_redemptions`. The FK
//      `promo_code_redemptions.promo_code_id -> promo_codes` is
//      `onDelete: Cascade` (prisma/schema.prisma), so deleting a promo
//      code CASCADE-deletes its redemption rows. A JOIN through those
//      tables (as the per-code claim queries do) would therefore SILENTLY
//      DROP every deleted / old code. The ledger row is never deleted with
//      the code, so summing the ledger directly captures deleted and old
//      codes too — exactly what "given out, overall, including deleted"
//      requires.
//
//   2. allocatedOffered — total budget PUT UP across the promo codes that
//      still exist: Σ (value × max_uses). This is the capped allocation we
//      offered. It can ONLY cover CURRENT codes — a deleted code's row is
//      gone and its value/max_uses cannot be reconstructed (the ledger
//      stores realized redemptions, not the un-redeemed remaining
//      allocation). So this number is honestly scoped to "current codes"
//      and labelled as such at the call site; it deliberately does NOT
//      claim to include deleted allocation.
//
// Both are lifetime aggregates with no timeframe selector. One cache
// entry (300s), wrapped in `safeQuery` at the call site so a failure
// degrades the two tiles to "—" instead of crashing the page.

export type PromoCodesMoneyStats = {
  /**
   * Realized house cost — Σ ABS(amount) of all completed
   * `promo_code_redeemed` ledger legs. Includes deleted / old codes
   * because it reads the immutable ledger, not the (cascade-deleted)
   * promo-code tables.
   */
  claimedGivenOut: number;
  /**
   * Total offered budget across CURRENT promo codes — Σ (value × max_uses).
   * Current codes only (deleted codes' allocation is unrecoverable).
   */
  allocatedOffered: number;
};

const cachedPromoCodesMoneyStats = unstable_cache(
  async (): Promise<PromoCodesMoneyStats> => {
    const db = await getDb();

    // Two independent single-row aggregates. The ledger sum is the
    // deleted-inclusive realized cost (no join); the allocation sum is the
    // current-codes offered budget. Run in parallel — one indexed scan on
    // ledger_transactions (status, type), one full aggregate on
    // promo_codes (small table).
    const [claimedRows, allocatedRows] = await Promise.all([
      db.$queryRaw<{ total: string }[]>`
        SELECT COALESCE(SUM(ABS(amount::numeric)), 0)::text AS total
        FROM ledger_transactions
        WHERE status = 'completed'
          AND type = 'promo_code_redeemed'
      `,
      db.$queryRaw<{ total: string }[]>`
        SELECT COALESCE(SUM(value::numeric * max_uses), 0)::text AS total
        FROM promo_codes
      `,
    ]);

    return {
      claimedGivenOut: toNumber(claimedRows[0]?.total ?? "0"),
      allocatedOffered: toNumber(allocatedRows[0]?.total ?? "0"),
    };
  },
  ["promo-codes-money-stats-v1"],
  { revalidate: 300, tags: ["promo-codes-money-stats"] },
);

/**
 * Lifetime promo-code money stats (realized given-out cost + offered
 * allocation) for the /promo-codes hero strip. Cached cross-request
 * (300s). See the module header for the deleted-codes sourcing rationale.
 */
export async function getPromoCodesMoneyStats(): Promise<PromoCodesMoneyStats> {
  return cachedPromoCodesMoneyStats();
}
