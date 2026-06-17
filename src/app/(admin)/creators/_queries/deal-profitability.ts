import "server-only";

import { adminDb } from "@/lib/admin-db";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { getWindowedWagerByUser } from "./actual-wager-windowed-by-user";
import { getTipsSponsorSpend } from "./tips-sponsor-spend";

/**
 * One active creator deal, costed out per its payout window and checked
 * against the actual wager the creator drove inside that window.
 *
 * Costs are HOUSE costs (house-POV): the withdraw cap we may have to
 * honour, the leaderboard pool we fund, and the tip pool we provide. The
 * deal's expected wager is the volume that house edge (7.5%) would need
 * to cover that cost; `conversionRate` is how much of that expectation
 * the creator's real wager actually delivered.
 */
export type CreatorProfitabilityRow = {
  userId: string;
  username: string | null;
  image: string | null;
  code: string | null;
  dealName: string | null;
  periodLabel: string;
  periodDays: number;
  withdrawCapCost: number;
  leaderboardFunding: number;
  tipCost: number;
  dealCost: number;
  expectedWager: number;
  actualWager: number;
  /** `expectedWager > 0 ? actualWager / expectedWager : 0`. */
  conversionRate: number;
};

export type ProfitabilityTotals = {
  totalCost: number;
  totalActualPnl: number;
  totalExpectedWagerMonthly: number;
  totalCreatorWager: number;
  avgConversionRate: number;
};

export type ProfitabilityData = {
  rows: CreatorProfitabilityRow[];
  totals: ProfitabilityTotals;
};

/** House edge used to translate a house cost into the wager needed to cover it. */
const HOUSE_EDGE = 0.075;
/** Average days per month — normalises mixed-window costs to a monthly figure. */
const DAYS_PER_MONTH = 30.4375;

type DealPeriod = { periodDays: number; periodLabel: string };

function resolvePeriod(
  leaderboardFrequency: string | null,
  currencyLimitResetDays: number | null,
): DealPeriod {
  const normalized = (leaderboardFrequency ?? "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (normalized.includes("month")) {
    return { periodDays: 30, periodLabel: "Monthly" };
  }
  if (normalized.includes("biweek")) {
    return { periodDays: 14, periodLabel: "Bi-Weekly" };
  }
  if (normalized.includes("week")) {
    return { periodDays: 7, periodLabel: "Weekly" };
  }
  const periodDays = currencyLimitResetDays ?? 7;
  return { periodDays, periodLabel: `${periodDays}-Day` };
}

/**
 * Creator Deal Profitability: every active deal costed out per its payout
 * window, compared against the creator's actual windowed wager and rolled
 * up into roster totals.
 *
 * The tips/sponsor spend aggregate degrades gracefully to zero on failure
 * so a single slow/failed read doesn't take the page down. The active-deal
 * lookup (admin DB) and the per-deal user + windowed-wager lookups are the
 * load-bearing reads.
 */
export async function getCreatorProfitability(): Promise<ProfitabilityData> {
  const deals = await adminDb.creator_deals.findMany({
    where: {
      status: "active",
      OR: [{ end_date: null }, { end_date: { gt: new Date() } }],
    },
    distinct: ["target_user_id"],
    select: {
      target_user_id: true,
      deal_name: true,
      currency_limit_amount: true,
      currency_limit_reset_days: true,
      leaderboard_prize_pool: true,
      leaderboard_our_share: true,
      leaderboard_frequency: true,
      tip_limit: true,
      tip_limit_reset_days: true,
    },
  });

  const targetUserIds = deals.map((d) => d.target_user_id);

  if (targetUserIds.length === 0) {
    return {
      rows: [],
      totals: {
        totalCost: 0,
        totalActualPnl: 0,
        totalExpectedWagerMonthly: 0,
        totalCreatorWager: 0,
        avgConversionRate: 0,
      },
    };
  }

  const db = await getDb();
  const userRows = await db.user.findMany({
    where: { id: { in: targetUserIds } },
    select: { id: true, username: true, image: true },
  });
  const userById = new Map(userRows.map((u) => [u.id, u]));

  // Primary affiliate code per creator (oldest-first) — the same
  // `affiliate_codes` access path the creators-list + code-and-wager
  // queries already use (read-only SELECT, keyed by user_id = ANY).
  const codeByUser = new Map<string, string>();
  try {
    const codeRows = await db.$queryRawUnsafe<
      { user_id: string; code: string }[]
    >(
      `SELECT DISTINCT ON (user_id) user_id, code
         FROM affiliate_codes
        WHERE user_id = ANY($1::text[])
        ORDER BY user_id, created_at ASC`,
      targetUserIds,
    );
    for (const r of codeRows) codeByUser.set(r.user_id, r.code);
  } catch {
    // No code → row renders without a code chip.
  }

  const windowedWager = await getWindowedWagerByUser(targetUserIds);

  const rows: CreatorProfitabilityRow[] = deals.map((deal) => {
    const { periodDays, periodLabel } = resolvePeriod(
      deal.leaderboard_frequency,
      deal.currency_limit_reset_days,
    );

    const currencyLimitAmount = deal.currency_limit_amount;
    const withdrawCapCost =
      currencyLimitAmount == null
        ? 0
        : toNumber(currencyLimitAmount) *
          (deal.currency_limit_reset_days
            ? periodDays / deal.currency_limit_reset_days
            : 1);

    const leaderboardFunding =
      toNumber(deal.leaderboard_prize_pool) *
      toNumber(deal.leaderboard_our_share);

    const tipLimit = deal.tip_limit;
    const tipCost =
      tipLimit == null
        ? 0
        : toNumber(tipLimit) *
          (deal.tip_limit_reset_days
            ? periodDays / deal.tip_limit_reset_days
            : 1);

    const dealCost = withdrawCapCost + leaderboardFunding + tipCost;
    const expectedWager = dealCost / HOUSE_EDGE;

    const window = windowedWager.get(deal.target_user_id) ?? {
      d7: 0,
      d14: 0,
      d30: 0,
    };
    const actualWager =
      periodDays <= 7 ? window.d7 : periodDays <= 14 ? window.d14 : window.d30;

    const conversionRate = expectedWager > 0 ? actualWager / expectedWager : 0;

    const user = userById.get(deal.target_user_id);

    return {
      userId: deal.target_user_id,
      username: user?.username ?? null,
      image: user?.image ?? null,
      code: codeByUser.get(deal.target_user_id) ?? null,
      dealName: deal.deal_name,
      periodLabel,
      periodDays,
      withdrawCapCost,
      leaderboardFunding,
      tipCost,
      dealCost,
      expectedWager,
      actualWager,
      conversionRate,
    };
  });

  rows.sort((a, b) => b.dealCost - a.dealCost);

  let sponsorSpendUsd = 0;
  try {
    const sponsorship = await getTipsSponsorSpend();
    sponsorSpendUsd = sponsorship.sponsorSpendUsd;
  } catch {
    sponsorSpendUsd = 0;
  }

  const totalDealCost = rows.reduce((acc, r) => acc + r.dealCost, 0);
  const totalCost = totalDealCost + sponsorSpendUsd;
  const totalExpectedWagerMonthly = rows.reduce(
    (acc, r) =>
      acc + (r.dealCost * (DAYS_PER_MONTH / r.periodDays)) / HOUSE_EDGE,
    0,
  );
  const totalCreatorWager = rows.reduce((acc, r) => acc + r.actualWager, 0);

  // Actual P&L of the deal program (house-POV): the GGR the creators'
  // real windowed wager throws off at the house edge, minus what those
  // deals cost us. Positive = the program is paying for itself. Derived
  // entirely from this page's own figures (no cross-surface dependency).
  const totalActualPnl = totalCreatorWager * HOUSE_EDGE - totalDealCost;

  const converting = rows.filter((r) => r.expectedWager > 0);
  const avgConversionRate =
    converting.length > 0
      ? converting.reduce((acc, r) => acc + r.conversionRate, 0) /
        converting.length
      : 0;

  return {
    rows,
    totals: {
      totalCost,
      totalActualPnl,
      totalExpectedWagerMonthly,
      totalCreatorWager,
      avgConversionRate,
    },
  };
}
