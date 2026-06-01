"use server";

import { requirePageAccess } from "@/lib/dal";
import {
  getRewardCategoryTopRecipients,
  getRewardsTopPromoCodes,
  parseRewardsPeriod,
  type RewardCategoryKey,
  type RewardTopRecipientRow,
  type RewardTopPromoCodeRow,
} from "@/lib/queries/rewards-analytics";
import {
  getLifetimePrizesTopWinners,
  type LifetimePrizesTopWinner,
} from "@/lib/queries/rewards-analytics-leaderboards";

/**
 * Server actions backing the lazy "Show top recipients" / "Show top
 * promo codes" expanders inside the breakdown popovers on
 * /rewards/analytics.
 *
 * The per-type breakdown for each KPI tile loads up-front with the
 * page (cheap — bounded by 1–3 ledger types per category). The
 * per-user and per-code lists are heavier (GROUP BY user_id or
 * promo_code_id over `ledger_transactions`) so they live behind a
 * click: this file only runs when the admin opens the expander.
 *
 * Both actions gate on `requirePageAccess('/rewards/analytics')` to
 * match the page itself and sanitize the free-string period via
 * `parseRewardsPeriod` so an unknown / tampered value falls back to
 * the default rather than throwing.
 */

const ALLOWED_CATEGORY_KEYS: readonly RewardCategoryKey[] = [
  "bonuses",
  "rakeback",
  "affiliate",
  "rainRace",
  "signupPack",
  "creatorTip",
  "waitlist",
];

function parseCategory(value: string | null): RewardCategoryKey | null {
  if (value === null || value === "all") return null;
  return (ALLOWED_CATEGORY_KEYS as readonly string[]).includes(value)
    ? (value as RewardCategoryKey)
    : null;
}

/**
 * Top reward recipients for a single category (or the site-wide
 * rollup when `categoryParam === "all"`). Sanitizes the category +
 * period strings on the way in so a tampered payload either resolves
 * to the all-rewards rollup (category) or the default 30d window
 * (period).
 */
export async function fetchRewardCategoryTopRecipients(
  periodParam: string,
  categoryParam: string,
  limit = 10,
): Promise<RewardTopRecipientRow[]> {
  await requirePageAccess("/rewards/analytics");
  const period = parseRewardsPeriod(periodParam);
  const category = parseCategory(categoryParam);
  return getRewardCategoryTopRecipients(period, category, limit);
}

/**
 * Top promo codes by redeemed value for the selected period. Only
 * called from the Bonuses & Promos popover — there's no analogous
 * "top gift cards" list because gift cards are one-shot codes
 * (`max_uses = 1`) and their breakdown is already auditable on the
 * /gift-cards page.
 */
export async function fetchRewardsTopPromoCodes(
  periodParam: string,
  limit = 10,
): Promise<RewardTopPromoCodeRow[]> {
  await requirePageAccess("/rewards/analytics");
  const period = parseRewardsPeriod(periodParam);
  return getRewardsTopPromoCodes(period, limit);
}

/**
 * All-time top prize winners across every race type. Backs the lazy
 * expander on the "Lifetime prizes paid" KPI tile. NOT period-scoped:
 * the headline KPI is lifetime, so the drilldown is too.
 */
export async function fetchLifetimePrizesTopWinners(
  limit = 10,
): Promise<LifetimePrizesTopWinner[]> {
  await requirePageAccess("/rewards/analytics");
  return getLifetimePrizesTopWinners(limit);
}
