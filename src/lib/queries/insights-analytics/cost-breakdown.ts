import "server-only";

import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { getCreatorSessionWindowsCte } from "@/lib/queries/creator-session-windows";
import {
  WAGER_TYPES_SQL,
  PAYOUT_TYPES_SQL,
  WAGER_PAYOUT_WAGER_TYPES,
  WAGER_PAYOUT_PAYOUT_TYPES,
} from "@/lib/queries/_wager-payout-types";
import { getMoneyFlowDecomposition } from "@/lib/queries/insights-analytics/money-flow";
import {
  periodToCutoff,
  type InsightsPeriod,
} from "@/app/(admin)/insights/analytics/types";

/**
 * Cost Breakdown — the full wager → P&L leakage waterfall.
 *
 * The user's recurring question: "$2.5M wagered but only $17k P&L —
 * where does all the money go?" This helper assembles ONE waterfall
 * that ties total wager down to realized P&L, itemizing every cost /
 * leakage category in between.
 *
 * ─── It is an ASSEMBLY, not new math ──────────────────────────────
 *
 * Every number is sourced from the existing query infrastructure so
 * this page reconciles, by construction, with /ggr, /dashboard, and
 * the /insights/analytics Money Flow tab:
 *
 *   • getMoneyFlowDecomposition(period) — the backbone. Returns the
 *     canonical windowed wager, payouts, GGR, per-type bonus breakdown,
 *     card withdrawals, inventory δ, voucher δ, windowed P&L, residual,
 *     and the daily GGR/bonuses/P&L series. Same cutoff + staff/
 *     blacklist exclusion + symmetric creator-on-stream filter the
 *     headline GGR uses, so `ggr` here equals /ggr's number.
 *
 * ─── The identity ─────────────────────────────────────────────────
 *
 * Canonical GGR sums the FULL 20-type payout set:
 *
 *   GGR = wager − payouts
 *       = wager − gamingPayouts − rewardPayouts
 *
 * where the payout set splits cleanly into:
 *   • gamingPayouts — the user's own gameplay winnings
 *       (battle_refund, upgrader_payout, card_sale, reward_card_sale,
 *        card_exchange, exchange_excess_credit)
 *   • rewardPayouts — house-funded marketing / retention gifts
 *       (deposit_bonus, rakeback_claim, race_prize, rain_win,
 *        gift_card_redeemed, promo_code_redeemed, voucher_redeemed,
 *        voucher_exchange, exchange_excess_to_voucher,
 *        battle_excess_to_voucher, balance_reward_claim, affiliate_claim,
 *        waitlist_prize, creator_tip)
 *
 * The money-flow helper's `bonusesByType` IS the rewardPayouts side
 * (same 14-type list), and `bonusesTotal` is its sum. So:
 *
 *   gamingPayouts = payouts − bonusesTotal
 *
 * No category is double-counted: wager − gamingPayouts − Σ(rewards) is
 * algebraically identical to wager − payouts = GGR.
 *
 * Then the GGR → P&L gap is the Money Flow identity:
 *
 *   P&L = GGR − cardWithdrawals − inventoryΔ − voucherΔ − residual
 *
 * Inventory δ and voucher δ are the "hidden" leaks — cards users won
 * but still hold (unrealized user winnings = house liability) and
 * unclaimed voucher value the house still owes. They're surfaced as
 * prominent first-class lines because they're why GGR can be positive
 * while realized P&L is thin.
 *
 * The residual is shown honestly — if the identity doesn't close to
 * $0 (dominated by creator on-stream GGR filtered out of headline GGR
 * but not the balance ledger, plus admin adjustments not tagged), it's
 * labelled "Unexplained residual" rather than fudged to zero.
 *
 * Read-only against Main DB.
 */

/** Sign of a waterfall line relative to the running total. */
export type CostLineKind =
  /** Adds to the running total (the starting wager). */
  | "base"
  /** A gameplay payout — the user's own winnings paid back. */
  | "gaming-payout"
  /** A reward / marketing payout — house-funded gift to the user. */
  | "reward"
  /** A balance-sheet liability that erodes GGR → P&L. */
  | "liability"
  /** The honest unexplained residual. */
  | "residual"
  /** A subtotal checkpoint (GGR). */
  | "subtotal"
  /** The final realized P&L. */
  | "result";

export type CostLine = {
  /** Stable key for React + export. */
  key: string;
  /** Human label. */
  label: string;
  /** One-line plain-English explanation of what this line is. */
  why: string;
  /** Absolute dollar magnitude (always >= 0 except base/subtotal/result which carry their own sign). */
  amount: number;
  /** Signed effect on the running total (base/subtotal/result use their natural sign; cost lines are negative). */
  signedAmount: number;
  kind: CostLineKind;
  /** % of GGR (signed amount / GGR). null when GGR is non-positive. */
  pctOfGgr: number | null;
  /** % of total wager. null when wager is zero. */
  pctOfWager: number | null;
  /** The underlying ledger type, when this line maps 1:1 to one (drives drill-in links + descriptions). */
  ledgerType?: string;
};

export type CostMarginHealth = {
  /** Return-to-player — payouts / wager (gaming + reward payouts back to users). null when no wager. */
  rtp: number | null;
  /** House edge — GGR / wager. null when no wager. */
  houseEdge: number | null;
  /** GGR as % of wager (same as houseEdge × 100, surfaced for the KPI). null when no wager. */
  ggrPctOfWager: number | null;
  /** Realized P&L as % of wager. null when no wager. */
  pnlPctOfWager: number | null;
  /** Total cost (everything between wager and P&L) as % of GGR. null when GGR non-positive. */
  costPctOfGgr: number | null;
  /** P&L as % of GGR — how much of the gross margin survived to realized. null when GGR non-positive. */
  pnlPctOfGgr: number | null;
};

export type CostBreakdownContributor = {
  userId: string;
  username: string | null;
  /** Wager-side total (house-POV). */
  wagerTotal: number;
  /** Payout-side total (house-POV). */
  payoutTotal: number;
  /** wagerTotal − payoutTotal. Positive = user lost (house profited). */
  net: number;
};

export type CostBreakdown = {
  periodLabel: string;
  cutoffIso: string;

  /** Total wager for the window (customer wager — creator on-stream excluded). */
  totalWager: number;
  /** Gaming payouts paid back to users (battle/card/upgrader/exchange wins). */
  gamingPayouts: number;
  /** Total reward / marketing payouts (the bonus family). */
  rewardPayouts: number;
  /** Canonical GGR = wager − payouts. */
  ggr: number;
  /** Card withdrawals shipped in the window (house liability realized). */
  cardWithdrawals: number;
  /** Inventory growth — cards users won and KEPT (unrealized user winnings). */
  inventoryDelta: number;
  /** Voucher growth — outstanding voucher liability issued − claimed. */
  voucherDelta: number;
  /** Honest unexplained residual. */
  residual: number;
  /** Realized windowed P&L (house perspective). */
  pnl: number;

  /**
   * Total cost between wager and P&L — everything that erodes wager
   * down to realized P&L. Equals wager − pnl. The denominator the
   * narrative uses for "how much went back".
   */
  totalCost: number;

  /**
   * The ordered waterfall lines, top (wager) to bottom (P&L), with the
   * GGR subtotal in the middle. Cost lines carry negative signedAmount.
   */
  lines: CostLine[];

  /**
   * Cost lines only (gaming payouts + each reward category + the three
   * liabilities + residual), sorted by magnitude DESC — the "ranked
   * leaks" view. The biggest leak is `rankedCosts[0]`.
   */
  rankedCosts: CostLine[];

  /** The single biggest leak (rankedCosts[0]), or null when there are none. */
  biggestLeak: CostLine | null;

  margin: CostMarginHealth;

  /** Daily GGR / total-cost / P&L series for the trend chart. */
  trend: Array<{ date: string; ggr: number; cost: number; pnl: number }>;

  /** Top users driving the gross gaming margin (the "who"). */
  contributors: CostBreakdownContributor[];
};

// ─── Reward (marketing) payout type set ─────────────────────────────
// Mirrors money-flow.ts's BONUS_TYPES exactly so `rewardPayouts` here
// equals that helper's `bonusesTotal` and the per-category split lines
// up with /insights/rewards. Kept as a local Set for the gaming-vs-
// reward partition of the canonical payout list.
const REWARD_PAYOUT_TYPES = new Set<string>([
  "deposit_bonus",
  "rakeback_claim",
  "voucher_redeemed",
  "gift_card_redeemed",
  "promo_code_redeemed",
  "race_prize",
  "rain_win",
  "waitlist_prize",
  "creator_tip",
  "balance_reward_claim",
  "affiliate_claim",
  "voucher_exchange",
  "exchange_excess_to_voucher",
  "battle_excess_to_voucher",
]);

/**
 * Per-ledger-type wager + payout totals for the window — the
 * authoritative split that ties to the canonical GGR.
 *
 * Byte-for-byte the same query shape as `cachedGgrBreakdownRows` in
 * dashboard.ts: the combined canonical wager∪payout type list, the same
 * staff+blacklist exclusion, and the SAME symmetric creator-on-stream
 * filter dropped on BOTH sides. The only difference is the cutoff is the
 * InsightsPeriod cutoff (so this works for 90d / lifetime, which the
 * DashboardPeriod-typed getGgrBreakdown can't express).
 *
 * Sourcing the gaming/reward partition AND the reward-category lines
 * from THIS one query — instead of mixing the money-flow helper's
 * differently-filtered `payouts` (session-filtered) and `bonusesByType`
 * (NOT session-filtered) — guarantees:
 *   • wager − gamingPayouts − Σ(rewards) = GGR exactly (one filter),
 *   • the reward category amounts match the payout side of /ggr,
 *   • no negative-clamp edge case on gamingPayouts.
 *
 * `sessionWindowsCte` is part of the cache key so a change in the
 * upstream creator session list invalidates the cached rows.
 */
const cachedTypeBreakdownRows = unstable_cache(
  async (
    blacklistIdNotIn: string,
    cutoffIso: string,
    sessionWindowsCte: string,
  ): Promise<{ type: string; total: string }[]> => {
    const db = await getDb();
    const cutoff = new Date(cutoffIso);
    const allTypesSql = Prisma.raw(
      `(${[...WAGER_PAYOUT_WAGER_TYPES, ...WAGER_PAYOUT_PAYOUT_TYPES]
        .map((t) => `'${t}'`)
        .join(",")})`,
    );
    return db.$queryRaw<{ type: string; total: string }[]>`
      WITH real_users AS (
        SELECT u.id, u.role FROM "user" u
        WHERE u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
      ),
      ${Prisma.raw(sessionWindowsCte)}
      SELECT
        lt.type::text AS type,
        COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total
      FROM ledger_transactions lt
      JOIN real_users ru ON ru.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.created_at >= ${cutoff}
        AND lt.type IN ${allTypesSql}
        AND NOT (
          ru.role = 'creator'
          AND EXISTS (
            SELECT 1 FROM session_windows sw
            WHERE sw.uid = lt.user_id
              AND lt.created_at >= sw.win_start
              AND lt.created_at <  sw.win_end
          )
        )
      GROUP BY lt.type
      ORDER BY total DESC
    `;
  },
  ["insights-cost-breakdown-type-rows-v1"],
  { revalidate: 60, tags: ["dashboard-stats", "insights-analytics"] },
);

/**
 * Human label for a reward ledger type → a grouped, operator-friendly
 * cost category. Several ledger types collapse into one category line
 * (e.g. gift_card_redeemed + promo_code_redeemed → "Promo / gift card
 * redemptions"; the three voucher credit types → "Voucher redemptions
 * + exchanges") so the waterfall reads like the task's spec instead of
 * 14 raw rows. Returns the category label + a stable category key.
 */
function rewardCategory(type: string): { key: string; label: string; why: string } {
  switch (type) {
    case "deposit_bonus":
      return {
        key: "deposit_bonus",
        label: "Deposit bonuses",
        why: "First-deposit / matched-deposit bonuses credited to user balance. Pure marketing cost.",
      };
    case "rakeback_claim":
      return {
        key: "rakeback",
        label: "Rakeback claims",
        why: "Percentage of wager volume returned to users as balance credit when they claim rakeback.",
      };
    case "gift_card_redeemed":
    case "promo_code_redeemed":
      return {
        key: "promo_gift",
        label: "Promo / gift card redemptions",
        why: "Admin- or marketing-issued promo codes and gift cards redeemed for balance.",
      };
    case "voucher_redeemed":
    case "voucher_exchange":
    case "exchange_excess_to_voucher":
    case "battle_excess_to_voucher":
      return {
        key: "voucher_redeem",
        label: "Voucher redemptions + exchanges",
        why: "Voucher value claimed as balance, plus exchange/battle excess routed through vouchers.",
      };
    case "rain_win":
      return {
        key: "rain",
        label: "Rain prizes",
        why: "Rain event prizes randomly distributed to entrants.",
      };
    case "race_prize":
      return {
        key: "race",
        label: "Race prizes",
        why: "Wager-race prizes paid to top finishers.",
      };
    case "waitlist_prize":
    case "balance_reward_claim":
      return {
        key: "leaderboard_waitlist",
        label: "Leaderboard / waitlist / balance rewards",
        why: "Waitlist queue prizes and daily/weekly/one-time balance rewards claimed by users.",
      };
    case "affiliate_claim":
      return {
        key: "affiliate",
        label: "Affiliate commissions",
        why: "Affiliate commission claimed by creators on their referred users' activity.",
      };
    case "creator_tip":
      return {
        key: "creator_tip",
        label: "Creator tips",
        why: "Tips routed from users to creators through the platform.",
      };
    default:
      return {
        key: type,
        label: type
          .split("_")
          .map((p) => (p.length === 0 ? p : p[0].toUpperCase() + p.slice(1)))
          .join(" "),
        why: "House-funded reward credited to user balance.",
      };
  }
}

/**
 * Top users driving the window's gross gaming margin — the "who".
 *
 * Mirrors getGgrTopContributors (dashboard.ts) EXACTLY — same canonical
 * wager/payout type sets, same staff+blacklist exclusion, same symmetric
 * creator-on-stream filter (drops on-stream rows on BOTH sides), same
 * ORDER BY ABS(net) DESC. The only difference is the cutoff is the
 * InsightsPeriod cutoff (so this works for 90d / lifetime which the
 * DashboardPeriod set the dashboard helper takes doesn't expose). NOT
 * cached — GROUP BY user_id is the heavy part and the page only loads
 * it once per render.
 */
async function getCostContributors(
  cutoff: Date,
  limit: number,
): Promise<CostBreakdownContributor[]> {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const db = await getDb();
  const [excluded, sessionWindowsCte] = await Promise.all([
    getExcludedUserIds(),
    getCreatorSessionWindowsCte(),
  ]);
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);
  const wagerIn = Prisma.raw(WAGER_TYPES_SQL);
  const payoutIn = Prisma.raw(PAYOUT_TYPES_SQL);
  const allTypesIn = Prisma.raw(
    `(${[...WAGER_PAYOUT_WAGER_TYPES, ...WAGER_PAYOUT_PAYOUT_TYPES]
      .map((t) => `'${t}'`)
      .join(",")})`,
  );

  const rows = await db.$queryRaw<
    {
      user_id: string;
      username: string | null;
      wager_total: string;
      payout_total: string;
      net: string;
    }[]
  >`
    WITH real_users AS (
      SELECT u.id, u.username, u.role
      FROM "user" u
      WHERE u.role NOT IN ('admin', 'support') ${Prisma.raw(blacklistIdNotIn)}
    ),
    ${Prisma.raw(sessionWindowsCte)},
    per_user AS (
      SELECT
        lt.user_id,
        COALESCE(SUM(CASE WHEN lt.type IN ${wagerIn}
                          THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS wager_total,
        COALESCE(SUM(CASE WHEN lt.type IN ${payoutIn}
                          THEN ABS(lt.amount::numeric) ELSE 0 END), 0) AS payout_total
      FROM ledger_transactions lt
      JOIN real_users ru ON ru.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.created_at >= ${cutoff}
        AND lt.type IN ${allTypesIn}
        AND NOT (
          ru.role = 'creator'
          AND EXISTS (
            SELECT 1 FROM session_windows sw
            WHERE sw.uid = lt.user_id
              AND lt.created_at >= sw.win_start
              AND lt.created_at <  sw.win_end
          )
        )
      GROUP BY lt.user_id
    )
    SELECT
      ru.id::text AS user_id,
      ru.username,
      pu.wager_total::text AS wager_total,
      pu.payout_total::text AS payout_total,
      (pu.wager_total - pu.payout_total)::text AS net
    FROM per_user pu
    JOIN real_users ru ON ru.id = pu.user_id
    ORDER BY ABS(pu.wager_total - pu.payout_total) DESC
    LIMIT ${safeLimit}
  `;
  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    wagerTotal: parseFloat(r.wager_total) || 0,
    payoutTotal: parseFloat(r.payout_total) || 0,
    net: parseFloat(r.net) || 0,
  }));
}

/**
 * Assemble the full cost-breakdown waterfall for the period.
 *
 * Sources:
 *   • The per-ledger-type wager + payout split (cachedTypeBreakdownRows)
 *     — gives the total wager, the gaming-vs-reward payout partition,
 *     each reward category, and the GGR, all under ONE consistent
 *     session/staff/blacklist filter that ties to the canonical GGR.
 *   • getMoneyFlowDecomposition — used ONLY for the GGR → P&L liability
 *     terms (card withdrawals, inventory δ, voucher δ, residual,
 *     windowed P&L) and the daily trend series.
 *   • getCostContributors — the per-user "who drove the margin".
 *
 * All three run off the SAME InsightsPeriod cutoff, so the wager + GGR
 * from the type breakdown equal the money-flow helper's wager + GGR by
 * construction (identical type sets, filter, cutoff). Read-only.
 */
export async function getCostBreakdown(
  period: InsightsPeriod,
  periodLabel: string,
  contributorLimit = 10,
): Promise<CostBreakdown> {
  const cutoff = periodToCutoff(period, new Date());

  const [excluded, sessionWindowsCte] = await Promise.all([
    getExcludedUserIds(),
    getCreatorSessionWindowsCte(),
  ]);
  const blacklistIdNotIn = blacklistNotInClause("id", excluded);

  const [typeRows, flow, contributors] = await Promise.all([
    cachedTypeBreakdownRows(
      blacklistIdNotIn,
      cutoff.toISOString(),
      sessionWindowsCte,
    ),
    getMoneyFlowDecomposition(period, periodLabel),
    getCostContributors(cutoff, contributorLimit),
  ]);

  // Partition the per-type rows (all session-filtered identically) into
  // wager / gaming-payout / reward-payout buckets via the canonical
  // type sets. wager − gamingPayouts − rewardPayouts = GGR exactly.
  const wagerSet = new Set<string>(WAGER_PAYOUT_WAGER_TYPES);
  let totalWager = 0;
  let gamingPayouts = 0;
  let rewardPayouts = 0;
  // Reward categories accumulated as we scan, so the reward lines come
  // from the SAME session-filtered rows as the partition totals.
  const rewardGroups = new Map<
    string,
    { label: string; why: string; total: number; types: string[] }
  >();
  for (const r of typeRows) {
    const total = toNumber(r.total);
    if (wagerSet.has(r.type)) {
      totalWager += total;
    } else if (REWARD_PAYOUT_TYPES.has(r.type)) {
      rewardPayouts += total;
      const cat = rewardCategory(r.type);
      const existing = rewardGroups.get(cat.key);
      if (existing) {
        existing.total += total;
        existing.types.push(r.type);
      } else {
        rewardGroups.set(cat.key, {
          label: cat.label,
          why: cat.why,
          total,
          types: [r.type],
        });
      }
    } else {
      // Remaining payout types are gameplay winnings (battle_refund,
      // upgrader_payout, card_sale, reward_card_sale, card_exchange,
      // exchange_excess_credit).
      gamingPayouts += total;
    }
  }
  // Canonical GGR for this cutoff = wager − all payouts. Equals the
  // money-flow helper's ggr by construction (same sets/filter/cutoff),
  // but derived from the type rows so the waterfall ties to its own
  // line items exactly.
  const ggr = totalWager - gamingPayouts - rewardPayouts;

  // GGR → P&L liability terms come from the money-flow decomposition.
  // The residual is recomputed against THIS page's GGR so the waterfall
  // closes to P&L exactly even if the money-flow GGR differs by a cent
  // of rounding from the type-row GGR.
  const cardWithdrawals = flow.cardWithdrawals;
  const inventoryDelta = flow.inventoryDelta;
  const voucherDelta = flow.voucherDelta;
  const pnl = flow.pnl;
  const residual = ggr - cardWithdrawals - inventoryDelta - voucherDelta - pnl;
  const totalCost = totalWager - pnl;

  // Helpers for the per-line ratios. GGR ratio uses signed magnitude so
  // a cost reads as "−X% of GGR".
  const pctOfGgr = (signed: number): number | null =>
    ggr > 0 ? (signed / ggr) * 100 : null;
  const pctOfWager = (signed: number): number | null =>
    totalWager > 0 ? (signed / totalWager) * 100 : null;

  const rewardLines: CostLine[] = [...rewardGroups.entries()]
    .map(([key, g]) => ({
      key: `reward:${key}`,
      label: g.label,
      why: g.why,
      amount: g.total,
      signedAmount: -g.total,
      kind: "reward" as const,
      pctOfGgr: pctOfGgr(g.total),
      pctOfWager: pctOfWager(g.total),
      // Single-type categories link straight to their ledger drill-in.
      ledgerType: g.types.length === 1 ? g.types[0] : undefined,
    }))
    .sort((a, b) => b.amount - a.amount);

  // ── Cost lines (everything that erodes wager → P&L), in waterfall
  //    order: gaming payouts first (largest structural giveback), then
  //    the reward categories, then the three balance-sheet liabilities,
  //    then the residual.
  const gamingLine: CostLine = {
    key: "gaming-payouts",
    label: "Gameplay winnings paid back",
    why: "Battle wins, card sales, upgrader payouts, and card exchanges — the user's own gameplay winnings credited back. This is the gross house edge giveback before any marketing cost.",
    amount: gamingPayouts,
    signedAmount: -gamingPayouts,
    kind: "gaming-payout",
    pctOfGgr: pctOfGgr(gamingPayouts),
    pctOfWager: pctOfWager(gamingPayouts),
  };

  const inventoryLine: CostLine = {
    key: "inventory",
    label: "Inventory value users still hold",
    why: "Cards users won and KEPT (obtained − sold/exchanged). Unrealized user winnings sitting as house liability — they can sell or physically withdraw any time. A big hidden leak: GGR counts the pack open, but the card is still ours to honour.",
    amount: inventoryDelta,
    signedAmount: -inventoryDelta,
    kind: "liability",
    pctOfGgr: pctOfGgr(inventoryDelta),
    pctOfWager: pctOfWager(inventoryDelta),
  };

  const cardWdLine: CostLine = {
    key: "card-withdrawals",
    label: "Card withdrawals (shipped)",
    why: "Physical cards shipped out in the window (card_withdrawal_requests, completed/shipped). Inventory that has now left the house entirely.",
    amount: cardWithdrawals,
    signedAmount: -cardWithdrawals,
    kind: "liability",
    pctOfGgr: pctOfGgr(cardWithdrawals),
    pctOfWager: pctOfWager(cardWithdrawals),
  };

  const voucherLine: CostLine = {
    key: "voucher-liability",
    label: "Unclaimed voucher liability",
    why: "Outstanding voucher value owed to users (issued − claimed). Until claimed it's a future balance credit waiting to land — a hidden liability the house still owes.",
    amount: voucherDelta,
    signedAmount: -voucherDelta,
    kind: "liability",
    pctOfGgr: pctOfGgr(voucherDelta),
    pctOfWager: pctOfWager(voucherDelta),
  };

  // Residual can be positive (more leaked than the named terms explain)
  // or negative (named terms over-explain). Sign carried through so the
  // running total still ties to P&L exactly.
  const residualLine: CostLine = {
    key: "residual",
    label:
      Math.abs(residual) > 0.05 * Math.max(Math.abs(ggr), 5000)
        ? "Unexplained residual"
        : "Residual",
    why: "What the named terms don't account for — dominated by creator on-stream GGR (filtered out of headline GGR but the balance still moved), plus admin balance adjustments not tagged 'Manual withdrawal:', fee types outside withdrawal_shipping_fee, and off-window timing. Shown honestly, not fudged to zero.",
    amount: Math.abs(residual),
    // A positive residual is a leak (negative effect on the running
    // total); a negative residual nudges P&L back up.
    signedAmount: -residual,
    kind: "residual",
    pctOfGgr: pctOfGgr(residual),
    pctOfWager: pctOfWager(residual),
  };

  // ── The full waterfall, top → bottom. Base (wager), all gaming +
  //    reward givebacks, GGR subtotal, the liabilities + residual, then
  //    realized P&L. The cost lines between base and the GGR subtotal
  //    sum to (wager − GGR); the cost lines after it sum to (GGR − P&L).
  const baseLine: CostLine = {
    key: "wager",
    label: "Total wager",
    why: "What customers staked across packs, battles, and the upgrader (creator on-stream sponsored play excluded). The top of the funnel.",
    amount: totalWager,
    signedAmount: totalWager,
    kind: "base",
    pctOfGgr: pctOfGgr(totalWager),
    pctOfWager: totalWager > 0 ? 100 : null,
  };

  const ggrSubtotal: CostLine = {
    key: "ggr",
    label: "Gaming margin kept (GGR)",
    why: "Wager minus everything paid back to users (gameplay winnings + all rewards). The house edge actually captured on the ledger. Equals the GGR on /ggr and /dashboard by construction.",
    amount: Math.abs(ggr),
    signedAmount: ggr,
    kind: "subtotal",
    pctOfGgr: ggr > 0 ? 100 : null,
    pctOfWager: pctOfWager(ggr),
  };

  const pnlResult: CostLine = {
    key: "pnl",
    label: "Net P&L (realized)",
    why: "House P&L for the window: deposits − withdrawals − Δbalance − Δinventory − Δvouchers. Same number as the P&L card on /dashboard. What actually survived to the bottom line.",
    amount: Math.abs(pnl),
    signedAmount: pnl,
    kind: "result",
    pctOfGgr: pctOfGgr(pnl),
    pctOfWager: pctOfWager(pnl),
  };

  const lines: CostLine[] = [
    baseLine,
    gamingLine,
    ...rewardLines,
    ggrSubtotal,
    inventoryLine,
    cardWdLine,
    voucherLine,
    residualLine,
    pnlResult,
  ];

  // Ranked leaks — every cost line (not base / subtotal / result),
  // biggest magnitude first.
  const rankedCosts = [gamingLine, ...rewardLines, inventoryLine, cardWdLine, voucherLine, residualLine]
    .slice()
    .sort((a, b) => b.amount - a.amount);

  // RTP = all money paid back to users (gaming winnings + rewards) over
  // wager. Equals (wager − GGR) / wager by construction.
  const totalPayouts = gamingPayouts + rewardPayouts;
  const margin: CostMarginHealth = {
    rtp: totalWager > 0 ? totalPayouts / totalWager : null,
    houseEdge: totalWager > 0 ? ggr / totalWager : null,
    ggrPctOfWager: totalWager > 0 ? (ggr / totalWager) * 100 : null,
    pnlPctOfWager: totalWager > 0 ? (pnl / totalWager) * 100 : null,
    costPctOfGgr: ggr > 0 ? (totalCost / ggr) * 100 : null,
    pnlPctOfGgr: ggr > 0 ? (pnl / ggr) * 100 : null,
  };

  // Daily trend — GGR + total cost (GGR − P&L per day) + P&L from the
  // money-flow series. cost is what flowed out of GGR that day.
  const trend = flow.timeSeries.map((pt) => ({
    date: pt.date,
    ggr: pt.ggr,
    cost: pt.ggr - pt.pnl,
    pnl: pt.pnl,
  }));

  return {
    periodLabel,
    cutoffIso: flow.cutoffIso,
    totalWager,
    gamingPayouts,
    rewardPayouts,
    ggr,
    cardWithdrawals,
    inventoryDelta,
    voucherDelta,
    residual,
    pnl,
    totalCost,
    lines,
    rankedCosts,
    biggestLeak: rankedCosts[0] ?? null,
    margin,
    trend,
    contributors,
  };
}
