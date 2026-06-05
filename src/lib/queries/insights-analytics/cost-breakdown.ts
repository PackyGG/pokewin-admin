import "server-only";

import { getDb } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { REWARD_PAYOUT_TYPES, RESIDUAL_TYPES } from "@/lib/metrics";
import {
  getWindowMetrics,
  getDailyGamingMetrics,
  sumLedgerTypes,
  sumOfficialStreamAdjustments,
  type MetricWindow,
} from "@/lib/metrics/queries";
import { calculateWindowedPnl } from "@/lib/metrics/realized-pnl";
import {
  periodToCutoff,
  type InsightsPeriod,
} from "@/app/(admin)/insights/analytics/types";
import {
  COUNTED_ADJUSTMENT_CATEGORY_KEYS,
  BALANCE_ADJUSTMENT_CATEGORY_META,
  adjustmentCategorySqlPredicate,
  type BalanceAdjustmentCategory,
} from "@/lib/balance-adjustment-categories";
import { getMetricsScope } from "@/lib/metrics/scope";

/**
 * Cost Breakdown — the full wager → P&L leakage waterfall, built on the
 * canonical `@/lib/metrics` layer.
 *
 * The user's recurring question: "$2.5M wagered but only $17k P&L —
 * where does all the money go?" This helper assembles ONE waterfall
 * that ties total wager down to realized P&L, itemizing every cost /
 * leakage category in between.
 *
 * ─── It is an ASSEMBLY of the canonical metric layer, not new math ──
 *
 * Every gaming-margin number is sourced from `src/lib/metrics` so this
 * page can no longer drift from /ggr, /dashboard or the other migrated
 * surfaces — there is exactly ONE definition of each metric and this
 * page calls it:
 *
 *   • getWindowMetrics()  — canonical WAGER, gaming PAYOUT (the verified
 *     inventory-delta model: Σ inventory.value_at_obtained for pack/
 *     battle + |battle_refund|, NOT the old "subtract card_sale" set),
 *     canonical GGR (= wager − gamingPayout) and canonical NGR (= GGR −
 *     reward cost, with rain netted via the owner-confirmed
 *     max(0, rain_win − rain_tip) model). Real-customer + borrow-
 *     corrected scope baked in.
 *   • getDailyGamingMetrics() — the per-day canonical GGR/NGR series for
 *     the trend chart, reconciling with the headline by construction.
 *   • sumLedgerTypes()    — Σ |amount| over any canonical type subset,
 *     under the SAME scope, used to itemize each REWARD_PAYOUT_TYPES
 *     category and every RESIDUAL_TYPES bucket as a named row.
 *   • calculateWindowedPnl() — the canonical realized windowed P&L
 *     (balance-sheet truth), run on the SAME scope (creators excluded)
 *     so the waterfall's foot reconciles with the metric scope it
 *     started from.
 *
 * ─── The canonical identity (house POV) ─────────────────────────────
 *
 *   GGR  = wager − gamingPayout            (gaming-only, inventory-delta)
 *   NGR  = GGR  − rewardCost − netRain     (house-funded giveaways)
 *
 * Card conversions (card_sale, card_exchange, reward_card_sale, the
 * voucher-exchange variants) are NEUTRAL — disposals of value the user
 * already owns — so they NEVER touch GGR's payout side. `creator_tip`
 * is a RESIDUAL pass-through (NOT a reward cost);
 * `affiliate_leaderboard_prize` IS a reward cost (was a gap).
 *
 * ─── GGR/NGR → realized P&L ─────────────────────────────────────────
 *
 * Canonical windowed P&L (balance-sheet truth, `calculateWindowedPnl`):
 *
 *   pnl = deposits − withdrawals − Δbalance − Δinventory − Δvouchers
 *
 * The gap between NGR (a gaming-margin number) and realized P&L is the
 * balance-sheet movement the gaming margin doesn't see:
 *   • Inventory δ — cards users won and KEPT (unrealized user winnings,
 *     a house liability).
 *   • Card withdrawals — physical cards shipped out (liability realized).
 *   • Voucher δ — outstanding voucher liability (issued − claimed).
 *   • Every RESIDUAL_TYPES ledger flow (deposit cash-in, vault transfers,
 *     rain pool funding, creator tips, admin adjustments, creator-deal
 *     fills, affiliate-leaderboard escrow, …) — enumerated as named rows
 *     rather than collapsed into one opaque "residual".
 *
 * What the named terms still don't account for is shown as a final,
 * honestly-labelled residual — small once every RESIDUAL_TYPES bucket is
 * itemized. Read-only against the Main DB.
 */

/** Sign of a waterfall line relative to the running total. */
export type CostLineKind =
  /** Adds to the running total (the starting wager). */
  | "base"
  /** A gameplay payout — the user's own winnings paid back. */
  | "gaming-payout"
  /** A reward / marketing payout — house-funded gift to the user. */
  | "reward"
  /** A balance-sheet liability that erodes NGR → P&L. */
  | "liability"
  /** A residual / balance-sheet ledger flow (RESIDUAL_TYPES), named. */
  | "residual"
  /** The honest unexplained residual left after every named bucket. */
  | "unexplained"
  /** A subtotal checkpoint (GGR or NGR). */
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
  /** Return-to-player — gaming payouts / wager. null when no wager. */
  rtp: number | null;
  /** House edge — GGR / wager. null when no wager. */
  houseEdge: number | null;
  /** GGR as % of wager (same as houseEdge × 100, surfaced for the KPI). null when no wager. */
  ggrPctOfWager: number | null;
  /** NGR as % of wager. null when no wager. */
  ngrPctOfWager: number | null;
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
  /**
   * Lifetime Total Wagered — the authoritative `balances.total_wagered`
   * counter (the SAME figure shown on `/users/[id]`).
   */
  wagerTotal: number;
  /**
   * Lifetime Total Won — the authoritative `balances.total_won` counter
   * (the SAME figure shown on `/users/[id]`).
   */
  payoutTotal: number;
  /**
   * wagerTotal − payoutTotal = the user's lifetime Wager Loss. House-POV:
   * positive = user net-LOST = house won (emerald). Equals the Wager Loss
   * tile on the user-detail page by construction.
   */
  net: number;
};

export type CostBreakdown = {
  periodLabel: string;
  cutoffIso: string;

  /** Total wager for the window (customer wager — canonical scope). */
  totalWager: number;
  /** Gaming payouts paid back to users (inventory-delta + battle_refund). */
  gamingPayouts: number;
  /** Total reward / marketing payouts (canonical reward cost incl. net rain). */
  rewardPayouts: number;
  /** Canonical GGR = wager − gaming payouts. */
  ggr: number;
  /** Canonical NGR = GGR − reward cost (net rain). */
  ngr: number;
  /** Card withdrawals shipped in the window (house liability realized). */
  cardWithdrawals: number;
  /** Inventory growth — cards users won and KEPT (unrealized user winnings). */
  inventoryDelta: number;
  /** Voucher growth — outstanding voucher liability issued − claimed. */
  voucherDelta: number;
  /** Sum of the itemized RESIDUAL_TYPES bridge rows (signed, house-POV effect on P&L). */
  residualNamedTotal: number;
  /** Honest unexplained residual after every named bucket is accounted for. */
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
   * GGR and NGR subtotals in the middle. Cost lines carry negative
   * signedAmount.
   */
  lines: CostLine[];

  /**
   * Cost lines only (gaming payouts + each reward category + the three
   * liabilities + named residual outflows + unexplained), sorted by
   * magnitude DESC — the "ranked leaks" view. The biggest leak is
   * `rankedCosts[0]`.
   */
  rankedCosts: CostLine[];

  /** The single biggest leak (rankedCosts[0]), or null when there are none. */
  biggestLeak: CostLine | null;

  margin: CostMarginHealth;

  /** Daily GGR / total-cost / P&L series for the trend chart. */
  trend: Array<{ date: string; ggr: number; cost: number; pnl: number }>;

  /**
   * Top users by lifetime authoritative Wager Loss (the "who"). Sourced
   * from `balances.total_wagered` / `total_won` — the SAME counters
   * `/users/[id]` shows — so each row reconciles with that user's
   * detail-page Wager Loss. Always lifetime (the counters are cumulative;
   * the main DB has no windowed `won`), independent of the period chip.
   */
  contributors: CostBreakdownContributor[];
};

// ─── Reward-category grouping ───────────────────────────────────────
//
// Each canonical REWARD_PAYOUT_TYPES member collapses into one grouped,
// operator-friendly cost category (e.g. gift_card_redeemed +
// promo_code_redeemed → "Promo / gift card redemptions"). Returns the
// category label + a stable category key. `creator_tip` is NOT here —
// it is a RESIDUAL pass-through, not a reward cost. `rain_win` is
// handled separately (net house cost) before this grouping runs.

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
      return {
        key: "voucher_redeem",
        label: "Voucher redemptions",
        why: "House-funded voucher value claimed as balance.",
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
    case "affiliate_leaderboard_prize":
      return {
        key: "affiliate_leaderboard",
        label: "Affiliate leaderboard prizes",
        why: "House-funded prizes paid to the top finishers of an affiliate leaderboard pool. Previously invisible to GGR/NGR — now counted as the reward cost it is.",
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

// ─── RESIDUAL_TYPES grouping ────────────────────────────────────────
//
// The canonical RESIDUAL_TYPES — balance-sheet / transfer / escrow /
// borrow / creator-deal flows excluded from both GGR and NGR — are
// itemized as named bridge rows (instead of one opaque catch-all) so
// the GGR/NGR → P&L gap is auditable. Each member collapses into a
// grouped row. `sign` is the row's effect on the HOUSE P&L running
// total: a cash inflow to the house (deposit) lifts P&L (+1); an
// outflow (card withdrawal, rain pool funding leg) lowers it (−1); a
// transfer that nets out (vault lock↔unlock, creator tip pass-through)
// is ~0 and shown for completeness.

type ResidualGroupKey =
  | "deposit"
  | "card_withdrawal"
  | "admin_adjustment"
  | "vault"
  | "rain_tip"
  | "creator_tip"
  | "borrow_voucher"
  | "affiliate_leaderboard_escrow"
  | "creator_fill";

function residualGroup(type: string): {
  key: ResidualGroupKey;
  label: string;
  why: string;
  /** Effect on the house-POV P&L running total: +1 inflow, −1 outflow, 0 net transfer. */
  sign: 1 | -1 | 0;
} {
  switch (type) {
    case "deposit":
      return {
        key: "deposit",
        label: "Deposits (cash in)",
        why: "Real cash users deposited in the window. A balance-sheet inflow — it funds the house, it is not a cost. Shown so the bridge from gaming margin to realized P&L is complete.",
        sign: 1,
      };
    case "card_withdrawal":
      return {
        key: "card_withdrawal",
        label: "Card-withdrawal ledger leg",
        why: "The `card_withdrawal` ledger entries. The authoritative shipped-card figure is the dedicated 'Card withdrawals (shipped)' liability line; this ledger leg is shown for completeness.",
        sign: -1,
      };
    case "admin_balance_adjustment":
      return {
        key: "admin_adjustment",
        label: "Admin balance adjustments",
        why: "Manual admin balance changes (corrections + manual-withdrawal debits). Mixed semantics — routed through realized P&L's balance delta, not the gaming margin.",
        sign: -1,
      };
    case "vault_lock":
    case "vault_unlock":
      return {
        key: "vault",
        label: "Vault lock / unlock (transfer)",
        why: "Balance ↔ vault transfers. They cancel out across the pair — neither a cost nor revenue, just value changing form.",
        sign: 0,
      };
    case "rain_tip":
      return {
        key: "rain_tip",
        label: "Rain pool funding (tips in)",
        why: "User + founder contributions into rain pools. A transfer/funding leg, not a house cost — the house slice of rain is netted into the rain reward line above (max(0, rain_win − rain_tip)).",
        sign: -1,
      };
    case "creator_tip":
      return {
        key: "creator_tip",
        label: "Creator tips (pass-through)",
        why: "Tips routed from users to creators through the platform. A verified user→user pass-through — both legs cancel to $0 net house cost, so it is NOT a reward cost.",
        sign: 0,
      };
    case "pack_borrow_to_voucher":
      return {
        key: "borrow_voucher",
        label: "Borrow-mode remainder → voucher",
        why: "Borrow-pack remainder routed to a voucher. Borrow plays are excluded from real-money P&L entirely.",
        sign: 0,
      };
    case "affiliate_leaderboard_creation":
    case "affiliate_leaderboard_refund":
      return {
        key: "affiliate_leaderboard_escrow",
        label: "Affiliate-leaderboard escrow",
        why: "Funds locked to create an affiliate-leaderboard pool, and any unspent remainder returned. An escrow round-trip — the prize payout itself is the reward-cost line above.",
        sign: 0,
      };
    case "creator_deal_fill_grant":
    case "creator_fill_activation":
    case "creator_fill_spend_tip":
    case "creator_fill_spend_battle":
    case "creator_fill_refund":
    case "creator_fill_conversion":
    case "creator_fill_forfeiture":
      return {
        key: "creator_fill",
        label: "Creator-deal fill lifecycle",
        why: "House-funded creator-deal promo balances (grant / activate / spend / refund / convert / forfeit). Excluded from customer gaming margin; surfaced here as a named bridge row.",
        sign: 0,
      };
    default:
      return {
        key: "creator_fill",
        label: "Other residual ledger flows",
        why: "Balance-sheet / transfer ledger flows excluded from the gaming margin.",
        sign: 0,
      };
  }
}

/**
 * Top users by AUTHORITATIVE wager-loss — the "who drove the margin".
 *
 * ─── Why this reads `balances`, not a ledger sweep ──────────────────
 *
 * The per-user wager / won shown on `/users/[id]` (Total Wagered /
 * Total Won / Wager Loss) is sourced from the production-maintained
 * `balances.total_wagered` / `balances.total_won` counters
 * (`users-detail.ts`). Those are the AUTHORITATIVE figures the operator
 * sees, and they are the reference this table must reconcile with.
 *
 * The previous implementation summed a LEGACY ledger payout set
 * (`_wager-payout-types.ts` `WAGER_PAYOUT_PAYOUT_TYPES`) which folds
 * `card_sale`, `voucher_redeemed`, `card_exchange` and every reward type
 * into the payout side — disposals of value the user already owns +
 * house-funded rewards, NOT gameplay winnings. That over-counted the
 * payout by ~1.1×–3.9× per user (verified against `balances.total_won`),
 * flipping the house-POV net deeply NEGATIVE for users the house was
 * actually UP on. The canonical inventory-delta payout
 * (`Σ value_at_obtained` + `battle_refund`) is ALSO not a faithful proxy
 * here: production prunes sold-card inventory rows, so a high-volume
 * user who has cashed out shows ~$0 inventory delta despite a large
 * `total_won` (and a still-holding whale shows 3×+ their `total_won`).
 * Neither ledger reconstruction matches the authoritative counter, so we
 * read the counter directly — the SAME columns `/users/[id]` reads.
 *
 * Net is house-POV: `wager_loss = total_wagered − total_won`; positive =
 * the user net-LOST = the house won (emerald). This equals the Wager
 * Loss tile on the user-detail page by construction.
 *
 * SCOPE: real customers only — staff + admin blacklist dropped, and
 * creators dropped wholesale by role (the same scope `getBridgeTerms`
 * uses in this file). The per-row creator-on-session window exclusion
 * the windowed legs use does NOT apply here: `balances.*` are cumulative
 * lifetime counters with no per-row timestamp to test against a session
 * window, so creators are excluded by role instead.
 *
 * LIFETIME: `balances.total_wagered` / `total_won` are cumulative
 * lifetime counters — there is no windowed equivalent on the main DB
 * (the production site keeps only `current_day/week/month_wagered_usd`,
 * and no windowed `won`). This ranking is therefore always lifetime,
 * independent of the page's period chip; the page footer states this so
 * it is not mistaken for a windowed, headline-summing figure. NOT cached
 * — one indexed scan over `balances`, loaded once per render.
 */
async function getCostContributors(
  limit: number,
): Promise<CostBreakdownContributor[]> {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const db = await getDb();
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn = blacklistNotInClause("u.id", excluded);

  const rows = await db.$queryRaw<
    {
      user_id: string;
      username: string | null;
      wager_total: string;
      payout_total: string;
      net: string;
    }[]
  >`
    SELECT
      u.id::text AS user_id,
      u.username,
      b.total_wagered::text AS wager_total,
      b.total_won::text AS payout_total,
      (b.total_wagered - b.total_won)::text AS net
    FROM balances b
    JOIN "user" u ON u.id = b.user_id
    WHERE u.role NOT IN ('admin', 'support', 'creator')
      ${Prisma.raw(blacklistIdNotIn)}
      AND (b.total_wagered <> 0 OR b.total_won <> 0)
    ORDER BY ABS(b.total_wagered - b.total_won) DESC
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
 * Balance-sheet bridge terms (card withdrawals + inventory δ + voucher
 * δ) under the SAME canonical metric scope as `getWindowMetrics`
 * (real customers = admin/support/creator dropped + admin blacklist).
 * Computed here (not pulled from money-flow, which uses a different
 * creator-on-session scope) so the waterfall foot reconciles with the
 * metric scope its head started from.
 *
 * `dropUserIds` is the admin blacklist ∪ the live creator-id list —
 * dropped from every term so the scope matches `realCustomersScope`
 * (which drops `creator` by role). The realized windowed P&L
 * (`calculateWindowedPnl`) is given the same drop-list via
 * `excludeUserIds`.
 */
type BridgeTerms = {
  cardWithdrawals: number;
  inventoryDelta: number;
  voucherDelta: number;
};

async function getBridgeTerms(
  cutoff: Date,
  dropUserIds: string[],
): Promise<BridgeTerms> {
  return withTiming("insights.costBreakdown.bridge", async () => {
    const db = await getDb();
    // Same scope predicate `realCustomersScope` bakes in: drop admin /
    // support / creator + the admin blacklist. `dropUserIds` is the
    // blacklist ∪ creator-id list (server-built ids, escaped defensively
    // by `blacklistNotInClause`). The cutoff is a server-constructed
    // Date, never user input — formatted to an ISO literal.
    const drop = blacklistNotInClause("u.id", dropUserIds);
    const scope = `u.role NOT IN ('admin', 'support', 'creator') ${drop}`;
    const since = `'${cutoff.toISOString()}'::timestamptz`;

    type CardRow = { total: string };
    type InvRow = { obtained: string; disposed: string };
    type VchRow = { issued: string; claimed: string };

    const [cardWd, inv, vch] = await Promise.all([
      db.$queryRawUnsafe<CardRow[]>(
        `SELECT COALESCE(SUM(cwr.total_value_usd::numeric), 0)::text AS total
         FROM card_withdrawal_requests cwr
         JOIN "user" u ON u.id = cwr.user_id
         WHERE cwr.status IN ('completed', 'shipped')
           AND COALESCE(cwr.completed_at, cwr.shipped_at) >= ${since}
           AND ${scope}`,
      ),
      db.$queryRawUnsafe<InvRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN ui.obtained_at >= ${since} THEN ui.value_at_obtained::numeric ELSE 0 END), 0)::text AS obtained,
           COALESCE(SUM(CASE WHEN (ui.sold_at >= ${since} OR ui.exchanged_at >= ${since}) THEN ui.value_at_obtained::numeric ELSE 0 END), 0)::text AS disposed
         FROM user_inventory ui
         JOIN "user" u ON u.id = ui.user_id
         WHERE (ui.obtained_at >= ${since} OR ui.sold_at >= ${since} OR ui.exchanged_at >= ${since})
           AND ${scope}`,
      ),
      db.$queryRawUnsafe<VchRow[]>(
        `SELECT
           COALESCE(SUM(CASE WHEN v.created_at >= ${since} THEN v.value::numeric ELSE 0 END), 0)::text AS issued,
           COALESCE(SUM(CASE WHEN v.claimed_at >= ${since} THEN v.value::numeric ELSE 0 END), 0)::text AS claimed
         FROM vouchers v
         JOIN "user" u ON u.id = v.user_id
         WHERE (v.created_at >= ${since} OR v.claimed_at >= ${since})
           AND ${scope}`,
      ),
    ]);

    return {
      cardWithdrawals: toNumber(cardWd[0]?.total),
      inventoryDelta:
        toNumber(inv[0]?.obtained) - toNumber(inv[0]?.disposed),
      voucherDelta: toNumber(vch[0]?.issued) - toNumber(vch[0]?.claimed),
    };
  });
}

/**
 * Live creator-id list — dropped from the canonical metric scope (which
 * excludes `creator` by role). Used to align `calculateWindowedPnl`
 * (which only excludes admin/support) and `getBridgeTerms` with the
 * `getWindowMetrics` scope so the whole waterfall sits on one population.
 */
async function getCreatorIds(): Promise<string[]> {
  const db = await getDb();
  const rows = await db.user.findMany({
    where: { role: "creator" },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/**
 * Σ |amount| of COUNTED categorized balance-adjustment CREDITS, per
 * category, over the window — through the SAME canonical scope as the
 * gaming metrics (`getMetricsScope`). Used to itemize each counted
 * category (Deposit problem / Giveaway / Bonus / Reload / Lossback) as its
 * own reward-cost line, and to know how much of the
 * `admin_balance_adjustment` residual is already counted as reward (so the
 * residual admin-adjustment line can exclude it — no double-count).
 *
 * These credits were lifted into NGR by `getRewardCost` via the exact same
 * `metadata->>'adjustment_category'` predicate, so the per-category sums
 * here reconcile with the reward cost (GGR − NGR) by construction.
 */
async function getCountedAdjustmentSumsByCategory(
  window: MetricWindow,
): Promise<{ byCategory: Map<BalanceAdjustmentCategory, number>; total: number }> {
  return withTiming("insights.costBreakdown.countedAdjustments", async () => {
    const db = await getDb();
    const scope = await getMetricsScope();
    const since = window.since;
    const sinceClause =
      since === null
        ? ""
        : `AND created_at >= '${since.toISOString()}'::timestamptz`;

    // One row per counted category — SUM(ABS(amount)) of credits carrying
    // that category. Built from the single canonical per-category predicate
    // so writer + metric + breakdown all agree on the key set.
    const selects = COUNTED_ADJUSTMENT_CATEGORY_KEYS.map(
      (key) =>
        `COALESCE(SUM(CASE WHEN ${adjustmentCategorySqlPredicate(key)} THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS "${key}"`,
    ).join(",\n         ");

    type Row = Record<string, string>;
    const rows = await db.$queryRawUnsafe<Row[]>(
      `WITH ${scope.sessionWindowsCte}
       SELECT
         ${selects}
       FROM ledger_transactions
       WHERE status = 'completed'
         AND type::text = 'admin_balance_adjustment'
         AND user_id IN ${scope.userScopeSql}
         AND ${scope.notInCreatorSession("user_id", "created_at")}
         ${sinceClause}`,
    );

    const row = rows[0];
    const byCategory = new Map<BalanceAdjustmentCategory, number>();
    let total = 0;
    for (const key of COUNTED_ADJUSTMENT_CATEGORY_KEYS) {
      const v = toNumber(row?.[key]);
      byCategory.set(key, v);
      total += v;
    }
    return { byCategory, total };
  });
}

/**
 * Assemble the full cost-breakdown waterfall for the period, entirely on
 * the canonical `@/lib/metrics` layer.
 *
 * Sources (all on ONE real-customer + borrow-corrected scope):
 *   • getWindowMetrics — canonical wager / gaming payout / GGR / NGR
 *     (inventory-delta model; net-rain NGR).
 *   • sumLedgerTypes — each reward category + each RESIDUAL_TYPES bucket
 *     as a named row.
 *   • calculateWindowedPnl (creators excluded) + getBridgeTerms — the
 *     balance-sheet bridge from NGR to realized P&L.
 *   • getDailyGamingMetrics — the canonical daily GGR/NGR trend.
 *   • getCostContributors — the per-user "who drove the margin", ranked
 *     by lifetime authoritative Wager Loss from `balances.total_wagered`
 *     / `total_won` (the SAME counters `/users/[id]` shows).
 *
 * Read-only.
 */
export async function getCostBreakdown(
  period: InsightsPeriod,
  periodLabel: string,
  contributorLimit = 10,
): Promise<CostBreakdown> {
  const cutoff = periodToCutoff(period, new Date());
  // Canonical window: all-time → no lower bound; otherwise the cutoff.
  const window: MetricWindow = {
    since: period === "all" ? null : cutoff,
  };

  const [excluded, creatorIds] = await Promise.all([
    getExcludedUserIds(),
    getCreatorIds(),
  ]);
  // The canonical metric scope drops creators by role; align the
  // realized-P&L and bridge-term scopes (which only drop admin/support)
  // by adding the live creator-id list to the drop set.
  const dropUserIds = [...excluded, ...creatorIds];

  const [
    metrics,
    windowedPnl,
    bridge,
    dailyMetrics,
    contributors,
    countedAdjustments,
    officialStreamSum,
  ] = await Promise.all([
    getWindowMetrics({ window }),
    calculateWindowedPnl({ since: cutoff, excludeUserIds: dropUserIds }),
    getBridgeTerms(cutoff, dropUserIds),
    getDailyGamingMetrics(window),
    getCostContributors(contributorLimit),
    getCountedAdjustmentSumsByCategory(window),
    // FAKE-BALANCE: Σ |amount| of official_stream adjustments (same scope) —
    // subtracted from the residual admin-adjustment line below so the fake
    // balance is never surfaced as a residual cost.
    sumOfficialStreamAdjustments({ window }),
  ]);

  const totalWager = metrics.wager;
  const gamingPayouts = metrics.gamingPayout;
  const ggr = metrics.ggr;
  const ngr = metrics.ngr;
  // Total reward cost (house-funded giveaways) = GGR − NGR. This is
  // reward-excl-rain + the net house slice of rain, by the canonical
  // NGR definition. Surfaced as a single headline figure; the per-
  // category lines below itemize it.
  const rewardPayouts = ggr - ngr;
  const netRainCost = metrics.rainHouseCost;

  const cardWithdrawals = bridge.cardWithdrawals;
  const inventoryDelta = bridge.inventoryDelta;
  const voucherDelta = bridge.voucherDelta;
  const pnl = windowedPnl.pnl;
  const totalCost = totalWager - pnl;

  // Per-line ratio helpers. GGR ratio uses signed magnitude so a cost
  // reads as "−X% of GGR".
  const pctOfGgr = (signed: number): number | null =>
    ggr > 0 ? (signed / ggr) * 100 : null;
  const pctOfWager = (signed: number): number | null =>
    totalWager > 0 ? (signed / totalWager) * 100 : null;

  // ── Reward-category lines ────────────────────────────────────────
  // Itemize each REWARD_PAYOUT_TYPES category via sumLedgerTypes (same
  // scope), grouping ledger types into operator-friendly categories.
  // rain_win is handled as its NET house cost (not the gross magnitude)
  // so the reward lines sum to the canonical reward cost (GGR − NGR).
  const rewardTypesExclRain = REWARD_PAYOUT_TYPES.filter(
    (t) => t !== "rain_win",
  );
  const rewardSums = await Promise.all(
    rewardTypesExclRain.map(async (type) => ({
      type,
      total: await sumLedgerTypes({ types: [type], window }),
    })),
  );

  const rewardGroups = new Map<
    string,
    { label: string; why: string; total: number; types: string[] }
  >();
  for (const { type, total } of rewardSums) {
    if (total <= 0) continue;
    const cat = rewardCategory(type);
    const existing = rewardGroups.get(cat.key);
    if (existing) {
      existing.total += total;
      existing.types.push(type);
    } else {
      rewardGroups.set(cat.key, {
        label: cat.label,
        why: cat.why,
        total,
        types: [type],
      });
    }
  }
  // Rain — net house cost (max(0, rain_win − rain_tip)), the
  // owner-confirmed model. Shown as its own reward line.
  if (netRainCost > 0) {
    rewardGroups.set("rain", {
      label: "Rain prizes (net house cost)",
      why: "Rain pool winnings beyond what user/founder tips funded — max(0, rain_win − rain_tip). Rain is system-automatic and mixed-funded; only the house's slice is a reward cost.",
      total: netRainCost,
      types: ["rain_win"],
    });
  }
  // Categorized balance-adjustment CREDITS — one reward line per COUNTED
  // category (Deposit problem / Giveaway / Bonus / Reload / Lossback).
  // These were lifted into NGR by `getRewardCost` (same canonical
  // `metadata->>'adjustment_category'` predicate), so itemizing them here
  // shows exactly where the money went and keeps the reward lines summing
  // to the canonical reward cost (GGR − NGR). `other` adjustments are NOT
  // here — they stay in the residual admin-adjustment line below.
  for (const key of COUNTED_ADJUSTMENT_CATEGORY_KEYS) {
    const total = countedAdjustments.byCategory.get(key) ?? 0;
    if (total <= 0) continue;
    const meta = BALANCE_ADJUSTMENT_CATEGORY_META[key];
    rewardGroups.set(`adjustment_${key}`, {
      label: meta.costLabel,
      why: meta.why,
      total,
      // ledgerType stays the shared adjustment type; with one category per
      // line `types.length === 1` keeps the existing single-type wiring.
      types: ["admin_balance_adjustment"],
    });
  }

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
      ledgerType: g.types.length === 1 ? g.types[0] : undefined,
    }))
    .sort((a, b) => b.amount - a.amount);

  // ── RESIDUAL_TYPES named bridge rows ─────────────────────────────
  // Itemize every RESIDUAL_TYPES bucket via sumLedgerTypes (same scope)
  // so the GGR/NGR → P&L gap is auditable, not a catch-all. Grouped by
  // residualGroup; `sign` is the row's house-POV effect on P&L.
  const residualSums = await Promise.all(
    RESIDUAL_TYPES.map(async (type) => {
      const raw = await sumLedgerTypes({ types: [type], window });
      // admin_balance_adjustment: the COUNTED categorized credits are now
      // their OWN reward lines (lifted into NGR). Subtract them from the
      // residual admin-adjustment line so they are not double-counted —
      // what remains is the uncounted slice (`other` + corrections +
      // manual-withdrawal debits). ALSO subtract the FAKE-BALANCE
      // official_stream slice (`officialStreamSum`) so it is never surfaced
      // as a residual admin-adjustment cost — owner-designated fake balance
      // is hidden from every computed figure. Clamp ≥ 0 defensively.
      const total =
        type === "admin_balance_adjustment"
          ? Math.max(0, raw - countedAdjustments.total - officialStreamSum)
          : raw;
      return { type, total };
    }),
  );
  const residualGroups = new Map<
    string,
    { label: string; why: string; total: number; sign: 1 | -1 | 0; types: string[] }
  >();
  for (const { type, total } of residualSums) {
    if (total <= 0) continue;
    const grp = residualGroup(type);
    const existing = residualGroups.get(grp.key);
    if (existing) {
      existing.total += total;
      existing.types.push(type);
    } else {
      residualGroups.set(grp.key, {
        label: grp.label,
        why: grp.why,
        total,
        sign: grp.sign,
        types: [type],
      });
    }
  }
  const residualLines: CostLine[] = [...residualGroups.entries()]
    .map(([key, g]) => ({
      key: `residual:${key}`,
      label: g.label,
      why: g.why,
      amount: g.total,
      // sign: +1 inflow lifts P&L, −1 outflow lowers it, 0 net transfer.
      signedAmount: g.sign * g.total,
      kind: "residual" as const,
      pctOfGgr: pctOfGgr(g.total),
      pctOfWager: pctOfWager(g.total),
      ledgerType: g.types.length === 1 ? g.types[0] : undefined,
    }))
    .sort((a, b) => b.amount - a.amount);
  const residualNamedTotal = residualLines.reduce(
    (sum, l) => sum + l.signedAmount,
    0,
  );

  // ── Balance-sheet liability lines (NGR → P&L) ────────────────────
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

  // ── Honest unexplained residual ──────────────────────────────────
  // Everything from NGR down to realized P&L should be accounted for by
  // the three liabilities + the named RESIDUAL_TYPES rows. The
  // unexplained residual is whatever is left — small once every bucket
  // is itemized. Running total from NGR:
  //   NGR − inventoryΔ − cardWd − voucherΔ + residualNamedTotal
  //   + unexplained = pnl
  const explainedFromNgr =
    ngr - inventoryDelta - cardWithdrawals - voucherDelta + residualNamedTotal;
  const unexplained = pnl - explainedFromNgr;

  const unexplainedLine: CostLine = {
    key: "unexplained",
    label:
      Math.abs(unexplained) > 0.05 * Math.max(Math.abs(ggr), 5000)
        ? "Unexplained residual"
        : "Residual (rounding / timing)",
    why: "What the named terms don't account for after every reward category, balance-sheet liability and RESIDUAL_TYPES bucket is itemized — off-window timing, neutral card-conversion ↔ inventory-delta edge cases, and rounding. Shown honestly, not fudged to zero.",
    amount: Math.abs(unexplained),
    // A positive unexplained nudges P&L up; negative is a leak.
    signedAmount: unexplained,
    kind: "unexplained",
    pctOfGgr: pctOfGgr(unexplained),
    pctOfWager: pctOfWager(unexplained),
  };

  // ── Subtotal / base / result lines ───────────────────────────────
  const baseLine: CostLine = {
    key: "wager",
    label: "Total wager",
    why: "What customers staked across packs and battles (creator on-stream sponsored play and borrow-mode plays excluded). The top of the funnel.",
    amount: totalWager,
    signedAmount: totalWager,
    kind: "base",
    pctOfGgr: pctOfGgr(totalWager),
    pctOfWager: totalWager > 0 ? 100 : null,
  };

  const gamingLine: CostLine = {
    key: "gaming-payouts",
    label: "Gameplay winnings paid back",
    why: "The cards users won and kept (inventory value at obtained) plus battle cash refunds — the user's own gameplay winnings. The verified inventory-delta payout: card sales/exchanges are NEUTRAL conversions and are NOT counted here (they don't move the gaming margin).",
    amount: gamingPayouts,
    signedAmount: -gamingPayouts,
    kind: "gaming-payout",
    pctOfGgr: pctOfGgr(gamingPayouts),
    pctOfWager: pctOfWager(gamingPayouts),
  };

  const ggrSubtotal: CostLine = {
    key: "ggr",
    label: "Gaming margin (GGR)",
    why: "Wager minus gameplay winnings paid back (inventory-delta + battle refunds). The gross house edge on gaming alone — before any marketing/reward cost. Equals the canonical GGR on /ggr and /dashboard.",
    amount: Math.abs(ggr),
    signedAmount: ggr,
    kind: "subtotal",
    pctOfGgr: ggr > 0 ? 100 : null,
    pctOfWager: pctOfWager(ggr),
  };

  const ngrSubtotal: CostLine = {
    key: "ngr",
    label: "Net gaming margin (NGR)",
    why: "GGR minus all house-funded reward / marketing spend (deposit bonuses, rakeback, prizes, the net house slice of rain, affiliate-leaderboard prizes, …). What the gaming business kept after giveaways.",
    amount: Math.abs(ngr),
    signedAmount: ngr,
    kind: "subtotal",
    pctOfGgr: pctOfGgr(ngr),
    pctOfWager: pctOfWager(ngr),
  };

  const pnlResult: CostLine = {
    key: "pnl",
    label: "Net P&L (realized)",
    why: "House P&L for the window: deposits − withdrawals − Δbalance − Δinventory − Δvouchers. Same canonical windowed P&L as the dashboard. What actually survived to the bottom line.",
    amount: Math.abs(pnl),
    signedAmount: pnl,
    kind: "result",
    pctOfGgr: pctOfGgr(pnl),
    pctOfWager: pctOfWager(pnl),
  };

  // ── The full waterfall, top → bottom. wager → gaming payout → GGR →
  //    reward lines → NGR → liabilities + named residual rows +
  //    unexplained → realized P&L.
  const lines: CostLine[] = [
    baseLine,
    gamingLine,
    ggrSubtotal,
    ...rewardLines,
    ngrSubtotal,
    inventoryLine,
    cardWdLine,
    voucherLine,
    ...residualLines,
    unexplainedLine,
    pnlResult,
  ];

  // Ranked leaks — every line that pulled money back to users (gaming
  // payout, rewards, liabilities) + the named residual OUTFLOWS, biggest
  // magnitude first. Pure inflows (deposits) and net-zero transfers are
  // not "leaks" so they're filtered. The unexplained line is included
  // only when it is itself a leak (negative effect on P&L).
  const rankedCosts = [
    gamingLine,
    ...rewardLines,
    inventoryLine,
    cardWdLine,
    voucherLine,
    ...residualLines.filter((l) => l.signedAmount < 0),
    ...(unexplained < 0 ? [unexplainedLine] : []),
  ]
    .slice()
    .filter((l) => l.amount > 0)
    .sort((a, b) => b.amount - a.amount);

  // RTP = gaming payouts / wager (the user's own winnings back). House
  // edge = GGR / wager.
  const margin: CostMarginHealth = {
    rtp: totalWager > 0 ? gamingPayouts / totalWager : null,
    houseEdge: totalWager > 0 ? ggr / totalWager : null,
    ggrPctOfWager: totalWager > 0 ? (ggr / totalWager) * 100 : null,
    ngrPctOfWager: totalWager > 0 ? (ngr / totalWager) * 100 : null,
    pnlPctOfWager: totalWager > 0 ? (pnl / totalWager) * 100 : null,
    costPctOfGgr: ggr > 0 ? (totalCost / ggr) * 100 : null,
    pnlPctOfGgr: ggr > 0 ? (pnl / ggr) * 100 : null,
  };

  // Daily trend — canonical GGR + per-day cost (GGR − NGR = the day's
  // reward giveback) + per-day NGR (the daily gaming-margin shape). The
  // authoritative realized P&L is the headline figure
  // (calculateWindowedPnl); this chart shows the GGR/giveback trend.
  const trend = dailyMetrics.map((pt) => ({
    date: pt.date,
    ggr: pt.ggr,
    cost: pt.ggr - pt.ngr,
    pnl: pt.ngr,
  }));

  return {
    periodLabel,
    cutoffIso: cutoff.toISOString(),
    totalWager,
    gamingPayouts,
    rewardPayouts,
    ggr,
    ngr,
    cardWithdrawals,
    inventoryDelta,
    voucherDelta,
    residualNamedTotal,
    residual: unexplained,
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
