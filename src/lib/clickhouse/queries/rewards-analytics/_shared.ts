import "server-only";

import type {
  RewardCategoryKey,
  RewardsPeriod,
} from "@/lib/queries/rewards-analytics";

/**
 * Shared ClickHouse fragments for the /rewards/analytics CH twins. These mirror
 * EXACTLY the canonical Postgres reward-cost definitions in
 * `src/lib/queries/rewards-analytics.ts` (`categoryCostPredicate`,
 * `ALL_SCANNED_TYPES_SQL`, `rewardRowPredicate`) and the canonical reward-cost
 * carve-outs already ported in `clickhouse/queries/window-metrics.ts`
 * (manual-voucher + counted-adjustment). Kept in one file so the overview and
 * category-breakdown twins use byte-identical row matching.
 *
 * CQRS boundary: the only imports are `import type` (erased at compile time) —
 * NO Postgres/Prisma client, directly or transitively.
 *
 * `metadata` is mirrored as a (Nullable) String JSON blob; `metadata->>'k'`
 * maps to `JSONExtractString(metadata,'k')` (returns '' for a missing key, so a
 * row without the key never matches — same as the PG `= '…'` comparison), the
 * exact analogue used by `window-metrics.ts` / `real-numbers.ts`.
 */

/** Mirror of the (non-exported) `daysForPeriod` in the PG twin. */
export function daysForRewardsPeriod(period: RewardsPeriod): number | null {
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
 * COUNTED adjustment-category keys, inlined as raw strings so the ClickHouse
 * read graph never imports `@/lib/balance-adjustment-categories` (which pulls
 * the engine-free `@/generated/prisma/browser` sentinel). Canonical source of
 * truth: `COUNTED_ADJUSTMENT_CATEGORY_KEYS` — the CREDIT categories EXCEPT
 * `other`, `official_stream`, and the removal-only debits. Same list the
 * window-metrics / real-numbers CH twins inline.
 */
const COUNTED_ADJ_CATEGORY_KEYS = [
  "deposit_problem",
  "withdrawal_failed",
  "giveaway",
  "bonus",
  "deposit_bonus",
  "bugs",
  "reload",
  "trivia",
  "lossback",
] as const;

const COUNTED_ADJ_CATEGORIES_SQL = `(${COUNTED_ADJ_CATEGORY_KEYS.map(
  (k) => `'${k.replace(/'/g, "''")}'`,
).join(",")})`;

/** CH twin of `type = 'voucher_redeemed' AND metadata->>'origin' = 'manual'`. */
export const MANUAL_VOUCHER_PRED = `(lt.type = 'voucher_redeemed' AND JSONExtractString(lt.metadata, 'origin') = 'manual')`;

/**
 * CH twin of `countedAdjustmentSqlPredicate()` — an `admin_balance_adjustment`
 * CREDIT (amount > 0) carrying a COUNTED `adjustment_category`. `amount > 0` is
 * a Decimal direction guard; the summed money stays Decimal.
 */
export const COUNTED_ADJ_PRED = `(lt.type = 'admin_balance_adjustment' AND lt.amount > 0 AND JSONExtractString(lt.metadata, 'adjustment_category') IN ${COUNTED_ADJ_CATEGORIES_SQL})`;

/** Inline a hardcoded ledger-type list into a CH `IN (...)` fragment. */
function typeListSql(types: readonly string[]): string {
  return `(${types.map((t) => `'${t.replace(/'/g, "''")}'`).join(",")})`;
}

const CATEGORY_TO_TYPES: Record<RewardCategoryKey, readonly string[]> = {
  bonuses: ["deposit_bonus", "promo_code_redeemed", "gift_card_redeemed"],
  rakeback: ["rakeback_claim"],
  affiliate: ["affiliate_claim", "affiliate_leaderboard_prize"],
  rainRace: [],
  signupPack: ["balance_reward_claim"],
  waitlist: ["waitlist_prize"],
  houseCredits: [],
};

/**
 * Per-category CH boolean predicate (alias `lt`), mirroring the PG
 * `categoryCostPredicate`. `rainRace` matches `race_prize` only here (the net
 * rain slice is added in JS from the separate rain_win/rain_tip legs);
 * `houseCredits` is the manual-voucher + counted-adjustment carve-out.
 */
export function categoryCostPredicateCh(category: RewardCategoryKey): string {
  if (category === "rainRace") {
    return `lt.type = 'race_prize'`;
  }
  if (category === "houseCredits") {
    return `(${MANUAL_VOUCHER_PRED} OR ${COUNTED_ADJ_PRED})`;
  }
  return `lt.type IN ${typeListSql(CATEGORY_TO_TYPES[category])}`;
}

/**
 * The set of ledger types any category row could come from — bounds the
 * headline / daily / recipient scans. Mirror of `ALL_SCANNED_TYPES_SQL`.
 */
export const ALL_SCANNED_TYPES_SQL = typeListSql([
  ...new Set([
    ...CATEGORY_TO_TYPES.bonuses,
    ...CATEGORY_TO_TYPES.rakeback,
    ...CATEGORY_TO_TYPES.affiliate,
    ...CATEGORY_TO_TYPES.signupPack,
    ...CATEGORY_TO_TYPES.waitlist,
    "race_prize",
    "rain_win",
    "rain_tip",
    "voucher_redeemed",
    "admin_balance_adjustment",
  ]),
]);

/**
 * CH twin of `rewardRowPredicate` — ANY reward-cost row across all categories
 * (flat types + race_prize + gross rain_win + manual voucher + counted adj;
 * rain_tip deliberately NOT matched). Used by the recipient leaderboard.
 */
export const REWARD_ROW_PRED = `(lt.type IN ${typeListSql([
  ...CATEGORY_TO_TYPES.bonuses,
  ...CATEGORY_TO_TYPES.rakeback,
  ...CATEGORY_TO_TYPES.affiliate,
  ...CATEGORY_TO_TYPES.signupPack,
  ...CATEGORY_TO_TYPES.waitlist,
  "race_prize",
  "rain_win",
])} OR ${MANUAL_VOUCHER_PRED} OR ${COUNTED_ADJ_PRED})`;
