import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";
import { parseRewardsPeriod, type RewardsPeriod } from "./rewards-analytics";
import {
  getDepositBonusCategoryAnalytics,
  type CategoryAnalytics,
} from "./rewards-category-analytics";

/**
 * Deposit-bonus deep-stats helper for /rewards/analytics' Deposit Bonus
 * tab.
 *
 * Wraps the shared `getDepositBonusCategoryAnalytics` (which provides
 * total / count / avg / median / max / unique recipients / daily series
 * / top users / top days) and layers deposit-bonus-specific stats on
 * top — currently the empirically-derived cap value + cap-hit rate.
 *
 * Cap value: the deposit-bonus cap is configured in the GAME BACKEND
 * (not in `site_config` on the main DB, and not in this admin
 * codebase). We therefore derive it empirically as `MAX(ABS(amount))`
 * observed in the period — that IS the largest payout the backend has
 * actually issued. "Cap hits" = count of rows whose ABS(amount) equals
 * that max. Stays correct if the cap is ever raised: the new max
 * becomes the new cap and the hit-rate naturally tracks it. If the cap
 * key shows up in site_config later, swap the source here and drop
 * the empirical derivation — every other call site stays the same.
 *
 * Per CLAUDE.md House-POV: deposit bonus is money the house GIVES
 * users → drag on house P&L → rose accent on the panel.
 */

export type DepositBonusAnalytics = CategoryAnalytics & {
  /** Observed cap — equal to `max`. */
  capValue: number;
  /** Count of rows where ABS(amount) === capValue. */
  capHits: number;
  /** capHits / count, 0–1. Multiply by 100 in the UI. */
  capHitRate: number;
};

function daysForPeriod(period: RewardsPeriod): number | null {
  switch (period) {
    case "today":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "all":
      return null;
  }
}

/**
 * Cap-hit count for the period — wrapped in its own cache so the lookup
 * stays cheap and the cache key tracks the period + blacklist signature.
 * The cap-equal scan is bounded to one COUNT(*) and only runs after we
 * already know the empirical max, so the round-trip is tiny.
 */
async function computeCapHits(
  period: RewardsPeriod,
  capValue: number,
  blacklistIds: string[],
): Promise<number> {
  if (capValue <= 0) return 0;
  const db = await getDb();
  const days = daysForPeriod(period);
  const dateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const blacklistSubquery = blacklistNotInClause("id", blacklistIds);

  const rows = await db.$queryRawUnsafe<{ cnt: string }[]>(`
    SELECT COUNT(*)::text AS cnt
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND lt.type = 'deposit_bonus'
      AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
      AND ABS(lt.amount::numeric) = ${capValue.toFixed(2)}
      ${dateFilter}
  `);
  return Number(rows[0]?.cnt ?? 0);
}

const cachedCapHits = unstable_cache(
  async (period: RewardsPeriod, capValue: number, blacklistIds: string[]) =>
    computeCapHits(period, capValue, blacklistIds),
  ["rewards-deposit-bonus-cap-hits-v1"],
  { revalidate: 60, tags: ["rewards-analytics"] },
);

export async function getDepositBonusAnalytics(
  period: RewardsPeriod,
): Promise<DepositBonusAnalytics> {
  const base = await getDepositBonusCategoryAnalytics(period);
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const capHits = await cachedCapHits(period, base.max, sorted);
  const capHitRate = base.count > 0 ? capHits / base.count : 0;
  return {
    ...base,
    capValue: base.max,
    capHits,
    capHitRate,
  };
}

// Re-export the period parser used by the analytics page so callers
// outside the page don't need a second import path.
export { parseRewardsPeriod };
