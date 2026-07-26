import { queryMainRows } from "@/lib/drizzle-query";
import "server-only";

import { unstable_cache } from "next/cache";

import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { MS_PER_DAY, MS_PER_MINUTE } from "@/lib/utils/time";
import { getMetricsScope } from "@/lib/metrics/scope";
import { upgraderMetrics } from "@/lib/metrics/queries";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
// READ-ONLY import of the canonical house-P&L formula + the fake-balance
// carve-out predicates. The creators-excluded realized-P&L mirror below uses
// the EXACT SAME arithmetic the balance-sheet snapshot (`_realized-pnl.ts`)
// uses — it only swaps the user population (drops creators too) — so the two
// can never drift on anything but the documented creator-scope difference.
import { computeHousePnl } from "@/lib/queries/pnl";
import {
  officialStreamAdjustmentSqlPredicate,
  removeLockedBalanceAdjustmentSqlPredicate,
} from "@/lib/balance-adjustment-categories";
import {
  GAMING_PAYOUT_TYPES_SQL,
  REWARD_PAYOUT_TYPES,
} from "@/lib/metrics/ledger-sets";
// READ-ONLY imports of the canonical reward-cost classification. The reward
// itemization below mirrors `@/lib/metrics/queries.ts` `getRewardCost`'s EXACT
// predicates (the REWARD_PAYOUT_TYPES set excl. rain, the manual-voucher
// carve-out, and the COUNTED balance-adjustment categories), so the sum of the
// itemized rows equals `getRewardCost(...).rewardCostExclRain + netRain`
// (= the page's headline reward cost, `cost.rewardPayouts = cost.ggr −
// cost.ngr`) BY CONSTRUCTION — not a re-derivation of the money math.
import {
  COUNTED_ADJUSTMENT_CATEGORY_KEYS,
  BALANCE_ADJUSTMENT_CATEGORY_META,
  adjustmentCategorySqlPredicate,
  type BalanceAdjustmentCategory,
} from "@/lib/balance-adjustment-categories";
// READ-ONLY import of the CANONICAL borrow/reward-pack predicates. These are
// the SAME fragments `@/lib/metrics/queries.ts` (`getGamingLegs` /
// `getWindowMetrics`) uses for the headline GGR, so the per-product split
// computed here reconciles with the headline BY CONSTRUCTION — whatever the
// current borrow basis is (borrow-exclusive today, borrow-inclusive after the
// gaming-sql fix lands), this module inherits it automatically because it
// imports the predicates rather than re-deriving them.
import {
  WAGER_LEG_FILTER,
  PAYOUT_LEG_FILTER,
} from "@/lib/metrics/gaming-sql";
// READ-ONLY import of the CANONICAL daily/free-pack giveaway cost. Daily packs
// (`packs.pack_type='reward'`, $0 wager) are NOT a REWARD_PAYOUT_TYPES ledger
// type — their cost is the value of the cards they hand out, tracked in
// `user_inventory`. `getDailyPacksTotalCost` is the SAME canonical aggregation
// the rest of the app uses (`/insights/rewards` daily-packs tab, the
// cost-breakdown program-spend block); we reuse it verbatim rather than
// re-deriving the cost, so this surface can never drift from it. Its scope is
// `realCustomersScopeSql()` == `getMetricsScope().userScopeSql` (staff +
// creators + blacklist dropped) and its `all` window is the SAME 365d cap
// (INSIGHTS_LIFETIME_LOOKBACK_DAYS) the rest of this page uses — so the figure
// is on an identical basis to the reward itemization.
import { getDailyPacksTotalCost } from "@/lib/queries/insights-rewards/daily-packs";
import { INSIGHTS_HUB_WAGER_LOOKBACK_DAYS } from "./hub-wager";

/**
 * real-numbers.ts — the per-PRODUCT GGR split for the "Real Numbers"
 * (Source of Truth) page.
 *
 * It is a THIN reconciling assembly on top of the canonical `@/lib/metrics`
 * layer, NOT new money math. The page's headline GGR / NGR / reward cost /
 * P&L all come from `getCostBreakdown` (which is itself an assembly of
 * `getWindowMetrics` + `calculateWindowedPnl`); this module only adds the
 * one thing the canonical layer does not expose directly — GGR broken out
 * per game line (packs / battles / upgrader) — and it does so on the EXACT
 * same scope, window and borrow/reward-pack predicates the headline uses,
 * so the three per-game GGRs SUM to the headline GGR by construction.
 *
 * ─── How the split maps onto the canonical legs ─────────────────────
 *
 * The canonical gaming payout (`getGamingLegs`) is:
 *   inventory payout (source pack+battle, PAYOUT_LEG_FILTER)
 *     + ledger gaming payout (battle_refund + battle_excess_to_voucher)
 *     + upgrader payout (upgrader_games.won_amount)
 * and the canonical wager is:
 *   ledger WAGER_TYPES (pack_opening + battle_bet + battle_sponsorship,
 *     WAGER_LEG_FILTER) + upgrader wager (upgrader_games.bet_amount).
 *
 * We attribute each leg to its product:
 *   • PACKS   — wager: pack_opening (WAGER_LEG_FILTER);
 *               payout: inventory source_type='pack' (PAYOUT_LEG_FILTER).
 *   • BATTLES — wager: battle_bet + battle_sponsorship (WAGER_LEG_FILTER);
 *               payout: inventory source_type='battle' (PAYOUT_LEG_FILTER)
 *               + the ledger gaming-payout legs (battle_refund +
 *               battle_excess_to_voucher — both are battle-win settlement
 *               legs).
 *   • UPGRADER — wager/payout straight from `upgraderMetrics`.
 *
 * Pack wager + battle wager + upgrader wager = canonical wager; pack payout
 * + battle payout + upgrader payout = canonical gaming payout; therefore
 * Σ per-game GGR = canonical GGR. The page asserts this and surfaces a tiny
 * reconciliation residual if a future leg appears that this split missed.
 *
 * Scope: the canonical real-customer scope (`getMetricsScope` — staff +
 * creators + blacklist dropped, creator-on-session rows excluded). Window:
 * the SAME 365d lifetime cap the /insights hub wager uses
 * ({@link INSIGHTS_HUB_WAGER_LOOKBACK_DAYS}). Read-only against the Main DB,
 * cached 5 min via `unstable_cache` keyed on the cutoff + scope inputs.
 */

/** One game line's gaming-margin economics. */
export type GameGgrRow = {
  /** Stable key. */
  key: "packs" | "battles" | "upgrader" | "keno";
  /** Display label. */
  label: string;
  /** Σ wager (stake placed), real customers, borrow-corrected. */
  wager: number;
  /** Σ gaming payout returned to users (inventory + cash legs). */
  payout: number;
  /** GGR = wager − payout (house POV; positive = house up). */
  ggr: number;
  /** Return-to-player = payout / wager (0..1), or null when no wager. */
  rtp: number | null;
  /** House edge = GGR / wager (0..1), or null when no wager. */
  houseEdge: number | null;
};

export type RealNumbersGameSplit = {
  /** Per-product GGR rows in display order (packs, battles, upgrader, keno). */
  games: GameGgrRow[];
  /** Σ of the per-game wager (= canonical wager). */
  totalWager: number;
  /** Σ of the per-game gaming payout (= canonical gaming payout). */
  totalPayout: number;
  /** Σ of the per-game GGR (= canonical headline GGR, by construction). */
  totalGgr: number;
  /** ISO cutoff of the lifetime window (now − 365d). */
  cutoffIso: string;
  /** The lifetime lookback cap (days) used — for the provenance line. */
  lookbackDays: number;
};

/** "now" floored to the whole minute so the cache key is stable for 60s. */
function bucketedNow(): Date {
  return new Date(Math.floor(Date.now() / MS_PER_MINUTE) * MS_PER_MINUTE);
}

/**
 * The cached inner read. The cutoff ISO + the scope inputs
 * (`userScopeSql`, `sessionWindowsCte`, the resolved per-row predicates) are
 * all baked into the cache key so a changed blacklist / creator-session set
 * can never serve a stale value. Tagged with the canonical insights tags so
 * an exclusion change or a wipe/restore busts it alongside the other
 * insights caches.
 */
const cachedGameSplit = unstable_cache(
  async (
    cutoffIso: string,
    userScopeSql: string,
    sessionWindowsCte: string,
    notInCreatorSessionLedger: string,
    notInCreatorSessionInv: string,
  ): Promise<{
    packWager: number;
    battleWager: number;
    packInvPayout: number;
    battleInvPayout: number;
    battleLedgerPayout: number;
    upgraderWager: number;
    upgraderPayout: number;
    kenoWager: number;
    kenoPayout: number;
  }> => {
    const since = `'${cutoffIso}'::timestamptz`;

    type WagerRow = {
      pack_wager: string;
      battle_wager: string;
      keno_wager: string;
    };
    type InvRow = { pack_inv: string; battle_inv: string };
    type LedgerPayoutRow = {
      battle_ledger_payout: string;
      keno_ledger_payout: string;
    };

    const [wagerRows, invRows, ledgerPayoutRows, upg] = await Promise.all([
      // Per-product WAGER from the ledger, under the canonical WAGER_LEG_FILTER
      // (the SAME predicate getGamingLegs applies). pack_opening → packs;
      // battle_bet + battle_sponsorship → battles. battle_sponsorship is
      // counted directly (no borrow gate) exactly as the headline does.
      queryMainRows<WagerRow[]>(
        `WITH ${sessionWindowsCte}
         SELECT
           COALESCE(SUM(CASE WHEN type::text = 'pack_opening'
             THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager,
           COALESCE(SUM(CASE WHEN type::text IN ('battle_bet','battle_sponsorship')
             THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager,
           COALESCE(SUM(CASE WHEN type::text = 'keno_bet'
             THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS keno_wager
         FROM ledger_transactions
         WHERE status = 'completed'
           AND type::text IN ('pack_opening','battle_bet','battle_sponsorship','keno_bet')
           AND user_id IN ${userScopeSql}
           AND ${notInCreatorSessionLedger}
           AND created_at >= ${since}
           AND ${WAGER_LEG_FILTER}`,
      ),
      // Per-product INVENTORY payout, under the canonical PAYOUT_LEG_FILTER
      // (the SAME predicate getGamingLegs applies). source_type splits the
      // two products; the borrow + reward-pack exclusion is identical.
      queryMainRows<InvRow[]>(
        `WITH ${sessionWindowsCte}
         SELECT
           COALESCE(SUM(CASE WHEN source_type = 'pack'
             THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS pack_inv,
           COALESCE(SUM(CASE WHEN source_type = 'battle'
             THEN value_at_obtained::numeric ELSE 0 END), 0)::text AS battle_inv
         FROM user_inventory
         WHERE source_type IN ('pack','battle')
           AND user_id IN ${userScopeSql}
           AND ${notInCreatorSessionInv}
           AND obtained_at >= ${since}
           AND ${PAYOUT_LEG_FILTER}`,
      ),
      // The LEDGER gaming-payout legs. Same GAMING_PAYOUT_TYPES set + scope
      // getGamingLegs sums (so the TOTAL still reconciles with the headline),
      // but split per product: battle_refund + battle_excess_to_voucher are
      // battle-win settlement legs, keno_payout is keno's win credit. Summing
      // the whole set into one bucket — as this did before keno joined the set
      // — would silently book keno payouts as battle payouts. No borrow flag on
      // these legs (summed unconditionally within the type filter), matching
      // the headline.
      queryMainRows<LedgerPayoutRow[]>(
        `WITH ${sessionWindowsCte}
         SELECT
           COALESCE(SUM(CASE WHEN type::text IN ('battle_refund','battle_excess_to_voucher')
             THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_ledger_payout,
           COALESCE(SUM(CASE WHEN type::text = 'keno_payout'
             THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS keno_ledger_payout
         FROM ledger_transactions
         WHERE status = 'completed'
           AND type::text IN ${GAMING_PAYOUT_TYPES_SQL}
           AND user_id IN ${userScopeSql}
           AND ${notInCreatorSessionLedger}
           AND created_at >= ${since}`,
      ),
      // Upgrader straight from the canonical reader (to_regclass-guarded →
      // null on a pre-upgrader DB).
      upgraderMetrics({ since: new Date(cutoffIso) }),
    ]);

    return {
      packWager: toNumber(wagerRows[0]?.pack_wager),
      battleWager: toNumber(wagerRows[0]?.battle_wager),
      packInvPayout: toNumber(invRows[0]?.pack_inv),
      battleInvPayout: toNumber(invRows[0]?.battle_inv),
      battleLedgerPayout: toNumber(ledgerPayoutRows[0]?.battle_ledger_payout),
      upgraderWager: upg?.wager ?? 0,
      upgraderPayout: upg?.payout ?? 0,
      kenoWager: toNumber(wagerRows[0]?.keno_wager),
      kenoPayout: toNumber(ledgerPayoutRows[0]?.keno_ledger_payout),
    };
  },
  ["insights-real-numbers-game-split-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

function makeRow(
  key: GameGgrRow["key"],
  label: string,
  wager: number,
  payout: number,
): GameGgrRow {
  const ggr = wager - payout;
  return {
    key,
    label,
    wager,
    payout,
    ggr,
    rtp: wager > 0 ? payout / wager : null,
    houseEdge: wager > 0 ? ggr / wager : null,
  };
}

/**
 * Per-product GGR split (packs / battles / upgrader / keno) over the lifetime
 * window, on the canonical real-customer + borrow-corrected scope.
 *
 * Reconciles with the headline `getCostBreakdown(...).ggr` /
 * `getWindowMetrics(...).ggr` by construction: it sums the SAME canonical
 * legs (ledger wager under WAGER_LEG_FILTER, inventory payout under
 * PAYOUT_LEG_FILTER, the GAMING_PAYOUT_TYPES ledger legs, and upgrader),
 * just partitioned by product. Read-only.
 */
export async function getRealNumbersGameSplit(): Promise<RealNumbersGameSplit> {
  return withTiming("insights.realNumbers.gameSplit", async () => {
    const now = bucketedNow();
    const cutoff = new Date(
      now.getTime() - INSIGHTS_HUB_WAGER_LOOKBACK_DAYS * MS_PER_DAY,
    );
    const cutoffIso = cutoff.toISOString();

    const scope = await getMetricsScope();
    const legs = await cachedGameSplit(
      cutoffIso,
      scope.userScopeSql,
      scope.sessionWindowsCte,
      scope.notInCreatorSession("user_id", "created_at"),
      scope.notInCreatorSession("user_id", "obtained_at"),
    );

    const packs = makeRow("packs", "Packs", legs.packWager, legs.packInvPayout);
    const battles = makeRow(
      "battles",
      "Battles",
      legs.battleWager,
      legs.battleInvPayout + legs.battleLedgerPayout,
    );
    const upgrader = makeRow(
      "upgrader",
      "Upgrader",
      legs.upgraderWager,
      legs.upgraderPayout,
    );

    // Keno is 100% ledger-native on both legs (keno_bet / keno_payout), so
    // unlike upgrader it needs no off-ledger table read — the same two ledger
    // queries above already carry it.
    const keno = makeRow("keno", "Keno", legs.kenoWager, legs.kenoPayout);

    const games = [packs, battles, upgrader, keno];
    const totalWager = games.reduce((s, g) => s + g.wager, 0);
    const totalPayout = games.reduce((s, g) => s + g.payout, 0);
    const totalGgr = games.reduce((s, g) => s + g.ggr, 0);

    return {
      games,
      totalWager,
      totalPayout,
      totalGgr,
      cutoffIso,
      lookbackDays: INSIGHTS_HUB_WAGER_LOOKBACK_DAYS,
    };
  });
}

// ─── Reward-spend itemization (every spent penny, where & why) ───────
//
// "Below the reward-spend line, show every reward dollar — where and why."
// This itemizes the page's headline reward cost
// (`getCostBreakdown(...).rewardPayouts` = `cost.ggr − cost.ngr`) into one
// row per source. It reconciles to that figure BY CONSTRUCTION because it
// mirrors `@/lib/metrics/queries.ts` `getRewardCost`'s EXACT composition:
//
//   rewardCost = rewardCostExclRain                 (this itemization, ex-rain)
//              + netRain                            (the rain row below)
//   where rewardCostExclRain =
//        Σ |amount| over REWARD_PAYOUT_TYPES EXCEPT rain_win   (per-type rows)
//      + Σ |amount| of voucher_redeemed WHERE origin='manual'  (manual voucher row)
//      + Σ |amount| of COUNTED admin_balance_adjustment credits (per-category rows)
//   and netRain = max(0, Σ|rain_win| − Σ|rain_tip|)            (the net-rain row)
//
// (See `getRewardCost` and `formulas.ts` `ngr`: NGR = GGR − rewardCostExclRain
// − netRain, so GGR − NGR = rewardCostExclRain + netRain.) Same canonical
// real-customer scope (`getMetricsScope`) and the same 365d-capped lifetime
// window the rest of the page uses, so the sum equals the headline reward cost.

/** A single itemized reward-spend line (one source of house-funded spend). */
export type RewardSpendRow = {
  /** Stable key. */
  key: string;
  /** Display label. */
  label: string;
  /** Short plain-language reason (House-POV: money we GAVE users = our cost). */
  why: string;
  /** Σ |amount| of house-funded spend for this source (always ≥ 0). */
  amount: number;
  /** Number of ledger rows behind it. `null` for the derived net-rain row. */
  count: number | null;
};

export type RewardSpendItemization = {
  /** Itemized rows, sorted by amount desc. */
  rows: RewardSpendRow[];
  /**
   * Σ of the row amounts = the canonical reward cost
   * (`getRewardCost(...).rewardCostExclRain + netRain` = the page's
   * `cost.rewardPayouts`), by construction.
   */
  total: number;
  /** Gross Σ|rain_win| (for the net-rain provenance line). */
  rainWinGross: number;
  /** Σ|rain_tip| offset netted out of rain (user/founder contributions). */
  rainTipOffset: number;
  /** Net house rain cost = max(0, rainWinGross − rainTipOffset). */
  netRain: number;
  /**
   * Daily / free-pack giveaway cost — the value of the cards the house hands
   * out via `pack_type='reward'` opens (≈ $0 wager), from the CANONICAL
   * `getDailyPacksTotalCost` helper on the SAME real-customer scope + 365d
   * window. Kept DELIBERATELY SEPARATE from `rows`/`total`: daily-pack cards
   * land in `user_inventory` (NOT a REWARD_PAYOUT ledger type) and are
   * EXCLUDED from the gaming payout that defines GGR, so they are NOT part of
   * the reward cost `GGR − NGR` that `total` reconciles to. They ARE captured
   * in the realized-P&L bottom line via the inventory the customer holds, so
   * folding them into `total` here would double-count them against GGR's
   * gaming payout and break the locked GGR→NGR→P&L reconciliation. Surfaced
   * as a clearly-labelled addendum line below the reconciling total instead.
   */
  dailyPacks: {
    /** Σ value_at_obtained of cards handed out by reward-pack opens (House-POV cost). */
    cost: number;
    /** Distinct reward-pack opens in the window. */
    opens: number;
    /** Distinct users who opened at least one reward pack. */
    claimers: number;
  };
  /** ISO cutoff of the lifetime window (now − 365d). */
  cutoffIso: string;
  /** The lifetime lookback cap (days) used. */
  lookbackDays: number;
};

/**
 * Plain-language, House-POV reason per reward source. Every line is money
 * the house GAVE to users = a house cost (rose). Wording is kept accurate to
 * the CLAUDE.md ledger mapping — no invented mechanics. `voucher_redeemed`,
 * `rain_win` and `admin_balance_adjustment` are NOT plain REWARD_PAYOUT_TYPES
 * members here (manual vouchers, net rain and counted adjustments are handled
 * as their own rows), so they never reach this switch.
 */
function rewardSpendMeta(type: string): { label: string; why: string } {
  switch (type) {
    case "deposit_bonus":
      return {
        label: "Deposit bonuses",
        why: "First / matched-deposit bonus credited to the user's balance.",
      };
    case "rakeback_claim":
      return {
        label: "Rakeback claims",
        why: "% of wager returned to the user when they claim rakeback.",
      };
    case "gift_card_redeemed":
      return {
        label: "Gift cards redeemed",
        why: "Gift card redeemed for balance.",
      };
    case "promo_code_redeemed":
      return {
        label: "Promo codes redeemed",
        why: "Promo code redeemed for balance.",
      };
    case "race_prize":
      return {
        label: "Race prizes",
        why: "On-site race competition prizes paid to top finishers.",
      };
    case "waitlist_prize":
      return {
        label: "Waitlist prizes",
        why: "Waitlist queue prize claimed by the user.",
      };
    case "balance_reward_claim":
      return {
        label: "Balance / signup rewards",
        why: "Signup-pack / balance reward claimed by the user.",
      };
    case "affiliate_claim":
      return {
        label: "Affiliate commissions",
        why: "Commission paid to affiliates on their referred users' wager.",
      };
    case "affiliate_leaderboard_prize":
      return {
        label: "Affiliate leaderboard prizes",
        why: "Prize pool paid to top affiliates — the % set per affiliate leaderboard.",
      };
    default:
      return {
        label: type
          .split("_")
          .map((p) => (p.length === 0 ? p : p[0].toUpperCase() + p.slice(1)))
          .join(" "),
        why: "House-funded reward credited to the user's balance.",
      };
  }
}

/**
 * The cached inner read. ONE pass over `ledger_transactions` on the canonical
 * scope/window computes, in parallel with itself via CASE sums:
 *   • Σ |amount| + COUNT per REWARD_PAYOUT_TYPES member (excl. rain_win),
 *   • Σ |amount| + COUNT of manual house vouchers
 *     (`voucher_redeemed` WHERE metadata->>'origin'='manual'),
 *   • Σ |amount| + COUNT per COUNTED admin_balance_adjustment category,
 *   • Σ |rain_win| / Σ |rain_tip| for the net-rain row.
 * The predicates are the SAME ones `getRewardCost` sums, so the assembled
 * total equals `getRewardCost(...).rewardCostExclRain + netRain`.
 *
 * Returns flat string maps (decimal-as-text) keyed by a stable column name so
 * the cache value stays a plain JSON object. All scope inputs are baked into
 * the cache key so a changed blacklist / creator-session set can never serve a
 * stale value; tagged with the canonical insights tags.
 */
const cachedRewardSpend = unstable_cache(
  async (
    cutoffIso: string,
    userScopeSql: string,
    sessionWindowsCte: string,
    notInCreatorSessionLedger: string,
  ): Promise<{
    amounts: Record<string, string>;
    counts: Record<string, string>;
    rainWin: string;
    rainTip: string;
  }> => {
    const since = `'${cutoffIso}'::timestamptz`;

    // Per-type reward legs (REWARD_PAYOUT_TYPES excl. rain_win) — the exact
    // set + |amount| treatment getRewardCost sums.
    const rewardTypesExclRain = REWARD_PAYOUT_TYPES.filter(
      (t) => t !== "rain_win",
    );
    const typeAmountSelects = rewardTypesExclRain
      .map(
        (t) =>
          `COALESCE(SUM(CASE WHEN type::text = '${t}' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS "amt_${t}"`,
      )
      .join(",\n           ");
    const typeCountSelects = rewardTypesExclRain
      .map(
        (t) =>
          `COALESCE(SUM(CASE WHEN type::text = '${t}' THEN 1 ELSE 0 END), 0)::text AS "cnt_${t}"`,
      )
      .join(",\n           ");

    // Per-counted-adjustment-category legs — the SAME canonical per-category
    // predicate (credit-only, metadata->>'adjustment_category') getRewardCost
    // lifts into reward cost.
    const adjAmountSelects = COUNTED_ADJUSTMENT_CATEGORY_KEYS.map(
      (k) =>
        `COALESCE(SUM(CASE WHEN ${adjustmentCategorySqlPredicate(k)} THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS "amt_adj_${k}"`,
    ).join(",\n           ");
    const adjCountSelects = COUNTED_ADJUSTMENT_CATEGORY_KEYS.map(
      (k) =>
        `COALESCE(SUM(CASE WHEN ${adjustmentCategorySqlPredicate(k)} THEN 1 ELSE 0 END), 0)::text AS "cnt_adj_${k}"`,
    ).join(",\n           ");

    type Row = Record<string, string>;
    const rows = await queryMainRows<Row[]>(
      `WITH ${sessionWindowsCte}
       SELECT
           ${typeAmountSelects},
           ${typeCountSelects},
           ${adjAmountSelects},
           ${adjCountSelects},
           -- Manual house-granted voucher carve-out: the ONLY ledger touchpoint
           -- of an admin-granted voucher is its redemption, so getRewardCost
           -- counts it as reward cost (metadata->>'origin'='manual').
           COALESCE(SUM(CASE WHEN type::text = 'voucher_redeemed' AND metadata->>'origin' = 'manual' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS "amt_manual_voucher",
           COALESCE(SUM(CASE WHEN type::text = 'voucher_redeemed' AND metadata->>'origin' = 'manual' THEN 1 ELSE 0 END), 0)::text AS "cnt_manual_voucher",
           -- Rain legs for the net-rain row (max(0, rain_win − rain_tip)).
           COALESCE(SUM(CASE WHEN type::text = 'rain_win' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS "rain_win",
           COALESCE(SUM(CASE WHEN type::text = 'rain_tip' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS "rain_tip"
         FROM ledger_transactions
         WHERE status = 'completed'
           AND user_id IN ${userScopeSql}
           AND ${notInCreatorSessionLedger}
           AND created_at >= ${since}`,
    );

    const row = rows[0] ?? {};
    const amounts: Record<string, string> = {};
    const counts: Record<string, string> = {};
    for (const t of rewardTypesExclRain) {
      amounts[t] = row[`amt_${t}`] ?? "0";
      counts[t] = row[`cnt_${t}`] ?? "0";
    }
    for (const k of COUNTED_ADJUSTMENT_CATEGORY_KEYS) {
      amounts[`adj_${k}`] = row[`amt_adj_${k}`] ?? "0";
      counts[`adj_${k}`] = row[`cnt_adj_${k}`] ?? "0";
    }
    amounts["manual_voucher"] = row["amt_manual_voucher"] ?? "0";
    counts["manual_voucher"] = row["cnt_manual_voucher"] ?? "0";

    return {
      amounts,
      counts,
      rainWin: row["rain_win"] ?? "0",
      rainTip: row["rain_tip"] ?? "0",
    };
  },
  ["insights-real-numbers-reward-spend-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

/**
 * Itemized reward-spend breakdown over the lifetime (365d-capped) window on
 * the canonical real-customer scope. The Σ of the rows equals the page's
 * headline reward cost (`getCostBreakdown(...).rewardPayouts` = GGR − NGR)
 * by construction — it mirrors `getRewardCost`'s exact predicates. Read-only.
 *
 * `creator_tip` is deliberately ABSENT from `rows`/`total` (it is a RESIDUAL
 * user→user pass-through, not a reward cost — owner decision: creator costs are
 * out of GGR/NGR).
 *
 * Daily / free packs are ALSO absent from `rows`/`total` (they are not in
 * `getRewardCost`), but — unlike creator tips — they ARE a genuine house
 * giveaway the owner wants surfaced. They are returned in the SEPARATE
 * `dailyPacks` field (from the canonical `getDailyPacksTotalCost`) so the
 * itemized panel can show them as an addendum line WITHOUT inflating `total`:
 * daily-pack cards are excluded from GGR's gaming payout and captured instead
 * in realized P&L via held inventory, so adding them to the reward-cost
 * subtotal would double-count them and break the GGR→NGR→P&L reconciliation.
 */
export async function getRewardSpendItemization(): Promise<RewardSpendItemization> {
  return withTiming("insights.realNumbers.rewardSpend", async () => {
    const now = bucketedNow();
    const cutoff = new Date(
      now.getTime() - INSIGHTS_HUB_WAGER_LOOKBACK_DAYS * MS_PER_DAY,
    );
    const cutoffIso = cutoff.toISOString();

    const scope = await getMetricsScope();
    // Fetch the reward-cost legs AND the canonical daily-pack giveaway cost in
    // parallel. `getDailyPacksTotalCost("all")` is the SAME aggregation the
    // /insights/rewards daily-packs tab + the cost-breakdown program block use,
    // on the SAME real-customer scope + 365d-capped `all` window — reused
    // verbatim so this surface can never diverge from the canonical figure.
    const [legs, dailyPacksTotal] = await Promise.all([
      cachedRewardSpend(
        cutoffIso,
        scope.userScopeSql,
        scope.sessionWindowsCte,
        scope.notInCreatorSession("user_id", "created_at"),
      ),
      getDailyPacksTotalCost("all"),
    ]);

    const rows: RewardSpendRow[] = [];

    // Per-type reward rows (REWARD_PAYOUT_TYPES excl. rain_win).
    for (const t of REWARD_PAYOUT_TYPES) {
      if (t === "rain_win") continue;
      const amount = toNumber(legs.amounts[t]);
      if (amount <= 0) continue;
      const meta = rewardSpendMeta(t);
      rows.push({
        key: t,
        label: meta.label,
        why: meta.why,
        amount,
        count: toNumber(legs.counts[t]),
      });
    }

    // Manual house voucher row (shown even at $0 per the owner's ask).
    {
      const amount = toNumber(legs.amounts["manual_voucher"]);
      rows.push({
        key: "manual_voucher",
        label: "Manual house vouchers",
        why: "Admin-granted house voucher redeemed for balance (no earlier grant row — the redemption is the cost).",
        amount,
        count: toNumber(legs.counts["manual_voucher"]),
      });
    }

    // Per-category counted balance-adjustment credit rows.
    for (const k of COUNTED_ADJUSTMENT_CATEGORY_KEYS) {
      const amount = toNumber(legs.amounts[`adj_${k}`]);
      if (amount <= 0) continue;
      const meta = BALANCE_ADJUSTMENT_CATEGORY_META[k as BalanceAdjustmentCategory];
      rows.push({
        key: `adj_${k}`,
        label: meta.costLabel,
        why: meta.why,
        amount,
        count: toNumber(legs.counts[`adj_${k}`]),
      });
    }

    // Net rain row — max(0, Σ|rain_win| − Σ|rain_tip|), the owner-confirmed
    // model. Shown even at $0 so the rain offset is visible.
    const rainWinGross = toNumber(legs.rainWin);
    const rainTipOffset = toNumber(legs.rainTip);
    const netRain = Math.max(0, rainWinGross - rainTipOffset);
    rows.push({
      key: "net_rain",
      label: "Rain pools (net house top-up)",
      why: "House's net top-up of rain pools, after user/founder tips — max(0, rain_win − rain_tip).",
      amount: netRain,
      // Derived from two legs (rain_win − rain_tip); a single row count would
      // be misleading, so it's omitted.
      count: null,
    });

    rows.sort((a, b) => b.amount - a.amount);
    const total = rows.reduce((s, r) => s + r.amount, 0);

    return {
      rows,
      total,
      rainWinGross,
      rainTipOffset,
      netRain,
      // Daily / free-pack giveaway — canonical, SEPARATE from rows/total (see
      // the `dailyPacks` field doc on RewardSpendItemization).
      dailyPacks: {
        cost: dailyPacksTotal.cost,
        opens: dailyPacksTotal.count,
        claimers: dailyPacksTotal.claimers,
      },
      cutoffIso,
      lookbackDays: INSIGHTS_HUB_WAGER_LOOKBACK_DAYS,
    };
  });
}

// ─── Realized P&L on the GGR/NGR customer scope (creators EXCLUDED) ──
//
// The GGR → realized-P&L BRIDGE on the Real Numbers page is anchored at GGR
// (a gaming-margin number scoped to real customers, creators dropped wholesale)
// and must end exactly at the canonical realized P&L
// (`getRealizedPnlSnapshot().pnl`, which INCLUDES creators — their real crypto
// withdrawals are a real cost). The bridge subtracts a "creator net cash" step
// to move between the two populations. To quantify that step EXACTLY we need
// the realized P&L computed on the GGR/NGR scope — i.e. the SAME balance-sheet
// formula as the snapshot, but with creators excluded too:
//
//   creatorEffect = pnlCustomersExclCreators − pnlInclCreators
//
// This module exposes ONLY `pnlCustomersExclCreators`. It mirrors
// `_realized-pnl.ts`'s `realizedPnlSnapshotInner` arithmetic LINE-FOR-LINE
// (deposits − [balance_withdrawn + card_withdrawn(pending/processing/shipped/
// completed)] − [available+locked − official_stream − remove_locked] −
// inventory(unsold/unexchanged/unlocked) − unclaimed vouchers − unclaimed
// rakeback), via the SAME `computeHousePnl` helper and the SAME fake-balance
// carve-out predicates — the ONLY change is the user population: the `real_users`
// CTE is the canonical customer scope (`getMetricsScope().userScopeSql` =
// role NOT IN ('admin','support','creator') + the excluded-users blacklist),
// instead of the snapshot's `role NOT IN ('admin','support')`. Read-only.
//
// Note on scope mechanics: these are PER-USER balance-sheet sums (balances,
// inventory, vouchers, rakeback), so the role-based `userScopeSql` user set is
// the complete and correct creator exclusion here. The creator-on-session
// per-row timestamp predicate (`notInCreatorSession`) is a ledger-row filter,
// not applicable to per-user balance totals, so it is intentionally not used —
// dropping creators wholesale by role already removes every creator's balances.

/** Realized P&L on the GGR/NGR customer scope (creators excluded). */
export type RealizedPnlCustomersExclCreators = {
  /**
   * House-perspective realized P&L on the canonical customer scope (staff +
   * creators + blacklist dropped). Same five-term formula as the balance-sheet
   * snapshot, plus the unclaimed-rakeback liability — so it is directly
   * comparable to `getRealizedPnlSnapshot().pnl` (the difference is purely the
   * creator population).
   */
  pnl: number;
};

const cachedPnlCustomersExclCreators = unstable_cache(
  async (userScopeSql: string): Promise<RealizedPnlCustomersExclCreators> => {
    // `userScopeSql` is the canonical `(SELECT id FROM "user" u WHERE …)`
    // subquery from getMetricsScope (staff + creators + blacklist dropped).
    // Mirror the snapshot's per-user balance-sheet aggregates exactly, just
    // over this population. (No `WITH real_users` rename needed — the scope
    // subquery is inlined directly as the `user_id IN (...)` set, identical in
    // meaning to the snapshot's CTE.)
    const rows = await queryMainRows<
      {
        deposited: string;
        balance_withdrawn: string;
        card_withdrawn: string;
        available_balance: string;
        locked_balance: string;
        inventory: string;
        vouchers: string;
        unclaimed_rakeback: string;
        official_stream_net: string;
        remove_locked_net: string;
      }[]
    >(`
      SELECT
        COALESCE((SELECT SUM(total_deposited::numeric)     FROM balances                 WHERE user_id IN ${userScopeSql}), 0)::text AS deposited,
        COALESCE((SELECT SUM(total_withdrawn::numeric)     FROM balances                 WHERE user_id IN ${userScopeSql}), 0)::text AS balance_withdrawn,
        COALESCE((SELECT SUM(total_value_usd::numeric)     FROM card_withdrawal_requests  WHERE status IN ('pending','processing','shipped','completed') AND user_id IN ${userScopeSql}), 0)::text AS card_withdrawn,
        COALESCE((SELECT SUM(available_balance::numeric)   FROM balances                 WHERE user_id IN ${userScopeSql}), 0)::text AS available_balance,
        COALESCE((SELECT SUM(locked_balance::numeric)      FROM balances                 WHERE user_id IN ${userScopeSql}), 0)::text AS locked_balance,
        COALESCE((SELECT SUM(value_at_obtained::numeric)   FROM user_inventory            WHERE sold_at IS NULL AND exchanged_at IS NULL AND withdrawal_locked_at IS NULL AND user_id IN ${userScopeSql}), 0)::text AS inventory,
        COALESCE((SELECT SUM(value::numeric)               FROM vouchers                  WHERE claimed_at IS NULL AND user_id IN ${userScopeSql}), 0)::text AS vouchers,
        COALESCE((SELECT SUM(rakeback_amount_usd::numeric) FROM rakeback_claims           WHERE claimed_at IS NULL AND user_id IN ${userScopeSql}), 0)::text AS unclaimed_rakeback,
        COALESCE((SELECT SUM(amount::numeric) FROM ledger_transactions WHERE status = 'completed' AND ${officialStreamAdjustmentSqlPredicate()} AND user_id IN ${userScopeSql}), 0)::text AS official_stream_net,
        COALESCE((SELECT SUM(amount::numeric) FROM ledger_transactions WHERE status = 'completed' AND ${removeLockedBalanceAdjustmentSqlPredicate()} AND user_id IN ${userScopeSql}), 0)::text AS remove_locked_net
    `);

    const r = rows[0];
    const totalDeposited = toNumber(r?.deposited);
    const balanceWithdrawn = toNumber(r?.balance_withdrawn);
    const cardWithdrawn = toNumber(r?.card_withdrawn);
    const totalWithdrawn = balanceWithdrawn + cardWithdrawn;
    const availableBalance = toNumber(r?.available_balance);
    const lockedBalance = toNumber(r?.locked_balance);
    const officialStreamNet = toNumber(r?.official_stream_net);
    const removeLockedNet = toNumber(r?.remove_locked_net);
    // Net out stats-excluded adjustments so they never enter the live-balance
    // P&L term — IDENTICAL to the snapshot.
    const userBalance =
      availableBalance + lockedBalance - officialStreamNet - removeLockedNet;
    const inventory = toNumber(r?.inventory);
    const vouchers = toNumber(r?.vouchers);
    const unclaimedRakeback = toNumber(r?.unclaimed_rakeback);

    // Canonical formula via the shared helper, then subtract the global-only
    // unclaimed-rakeback liability — EXACTLY as the snapshot does.
    const pnl =
      computeHousePnl({
        deposits: totalDeposited,
        withdrawals: totalWithdrawn,
        onSiteBalance: userBalance,
        inventoryValue: inventory,
        unclaimedVouchers: vouchers,
      }) - unclaimedRakeback;

    return { pnl };
  },
  ["insights-real-numbers-pnl-excl-creators-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

/**
 * Realized P&L on the canonical GGR/NGR customer scope (staff + creators +
 * blacklist dropped) — the SAME balance-sheet formula as
 * `getRealizedPnlSnapshot`, with creators additionally excluded so the Real
 * Numbers GGR → P&L bridge can quantify the creator step exactly:
 *
 *   creatorEffect = pnlCustomersExclCreators − pnlInclCreators
 *
 * `userScopeSql` is baked into the cache key so a blacklist change can't serve
 * a stale value; tagged with the canonical insights tags so a wipe/restore /
 * exclusion change busts it alongside the other insights caches. Read-only
 * against the Main DB.
 */
export async function getRealizedPnlCustomersExclCreators(): Promise<RealizedPnlCustomersExclCreators> {
  return withTiming("insights.realNumbers.pnlExclCreators", async () => {
    const scope = await getMetricsScope();
    return cachedPnlCustomersExclCreators(scope.userScopeSql);
  });
}

// ─── Creator net-cash detail (the bridge "Creator net cash" sub-breakdown) ──
//
// The GGR → realized-P&L bridge's "Creator net cash" step is an EXACT plug:
//   creatorEffect = pnlCustomersExclCreators − pnlInclCreators
// (creators are out of GGR/NGR but IN the balance-sheet snapshot). Because the
// snapshot keeps creators while the GGR/NGR scope drops them, the cash that
// population difference moves is, by the balance-sheet identity, simply the
// creators' OWN realized P&L: deposits − withdrawals − holdings. This detail
// breaks that one step into its three visible sub-rows so the bridge line is
// auditable, not opaque.
//
// It mirrors `_realized-pnl.ts`'s `realizedPnlSnapshotInner` arithmetic
// LINE-FOR-LINE (deposits = balances.total_deposited; withdrawals =
// balances.total_withdrawn + card_withdrawal_requests pending/processing/
// shipped/completed total_value_usd; holdings = available+locked −
// official_stream − remove_locked + inventory(unsold/unexchanged/unlocked
// value_at_obtained) + unclaimed vouchers + unclaimed rakeback), via the SAME
// fake-balance carve-out predicates — the ONLY change is the user population:
// `role = 'creator'` (NOT the blacklisted) instead of the snapshot's
// `role NOT IN ('admin','support')`. So `netCash` here equals
// −creatorEffect by construction (the creators' realized P&L is the negative
// of the cash they drag out of the snapshot). Read-only against the Main DB.

/** The three sub-components of the bridge's "Creator net cash" step. */
export type CreatorNetCashDetail = {
  /** Real crypto/cash creators deposited (balances.total_deposited). */
  deposited: number;
  /**
   * Real cash + cards creators withdrew (balances.total_withdrawn +
   * card_withdrawal_requests pending/processing/shipped/completed).
   */
  withdrawn: number;
  /**
   * Value creators still hold = on-site balance (fake-balance carved out) +
   * inventory + unclaimed vouchers + unclaimed rakeback. A house liability.
   */
  holdings: number;
  /**
   * Creators' realized P&L = deposited − withdrawn − holdings (House POV:
   * negative = creators are a net cash COST, like any withdrawing user).
   * Equals −creatorEffect, so the bridge's creator step ties out by
   * construction.
   */
  netCash: number;
};

const cachedCreatorNetCashDetail = unstable_cache(
  async (creatorScopeSql: string): Promise<CreatorNetCashDetail> => {
    // Same per-user balance-sheet aggregates as the snapshot, over the
    // creator population (`role = 'creator'`, not blacklisted). The scope
    // subquery is inlined directly as the `user_id IN (...)` set.
    const rows = await queryMainRows<
      {
        deposited: string;
        balance_withdrawn: string;
        card_withdrawn: string;
        available_balance: string;
        locked_balance: string;
        inventory: string;
        vouchers: string;
        unclaimed_rakeback: string;
        official_stream_net: string;
        remove_locked_net: string;
      }[]
    >(`
      SELECT
        COALESCE((SELECT SUM(total_deposited::numeric)     FROM balances                 WHERE user_id IN ${creatorScopeSql}), 0)::text AS deposited,
        COALESCE((SELECT SUM(total_withdrawn::numeric)     FROM balances                 WHERE user_id IN ${creatorScopeSql}), 0)::text AS balance_withdrawn,
        COALESCE((SELECT SUM(total_value_usd::numeric)     FROM card_withdrawal_requests  WHERE status IN ('pending','processing','shipped','completed') AND user_id IN ${creatorScopeSql}), 0)::text AS card_withdrawn,
        COALESCE((SELECT SUM(available_balance::numeric)   FROM balances                 WHERE user_id IN ${creatorScopeSql}), 0)::text AS available_balance,
        COALESCE((SELECT SUM(locked_balance::numeric)      FROM balances                 WHERE user_id IN ${creatorScopeSql}), 0)::text AS locked_balance,
        COALESCE((SELECT SUM(value_at_obtained::numeric)   FROM user_inventory            WHERE sold_at IS NULL AND exchanged_at IS NULL AND withdrawal_locked_at IS NULL AND user_id IN ${creatorScopeSql}), 0)::text AS inventory,
        COALESCE((SELECT SUM(value::numeric)               FROM vouchers                  WHERE claimed_at IS NULL AND user_id IN ${creatorScopeSql}), 0)::text AS vouchers,
        COALESCE((SELECT SUM(rakeback_amount_usd::numeric) FROM rakeback_claims           WHERE claimed_at IS NULL AND user_id IN ${creatorScopeSql}), 0)::text AS unclaimed_rakeback,
        COALESCE((SELECT SUM(amount::numeric) FROM ledger_transactions WHERE status = 'completed' AND ${officialStreamAdjustmentSqlPredicate()} AND user_id IN ${creatorScopeSql}), 0)::text AS official_stream_net,
        COALESCE((SELECT SUM(amount::numeric) FROM ledger_transactions WHERE status = 'completed' AND ${removeLockedBalanceAdjustmentSqlPredicate()} AND user_id IN ${creatorScopeSql}), 0)::text AS remove_locked_net
    `);

    const r = rows[0];
    const deposited = toNumber(r?.deposited);
    const balanceWithdrawn = toNumber(r?.balance_withdrawn);
    const cardWithdrawn = toNumber(r?.card_withdrawn);
    const withdrawn = balanceWithdrawn + cardWithdrawn;
    const availableBalance = toNumber(r?.available_balance);
    const lockedBalance = toNumber(r?.locked_balance);
    const officialStreamNet = toNumber(r?.official_stream_net);
    const removeLockedNet = toNumber(r?.remove_locked_net);
    // Fake-balance carve-out — IDENTICAL to the snapshot.
    const onSiteBalance =
      availableBalance + lockedBalance - officialStreamNet - removeLockedNet;
    const inventory = toNumber(r?.inventory);
    const vouchers = toNumber(r?.vouchers);
    const unclaimedRakeback = toNumber(r?.unclaimed_rakeback);

    const holdings = onSiteBalance + inventory + vouchers + unclaimedRakeback;
    // Creators' realized P&L = deposits − withdrawals − holdings (the same
    // five-term + rakeback identity the snapshot uses, regrouped into the
    // three visible legs). House POV: negative = creators cost us cash.
    const netCash = deposited - withdrawn - holdings;

    return { deposited, withdrawn, holdings, netCash };
  },
  ["insights-real-numbers-creator-net-cash-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

/**
 * The "Creator net cash" bridge step, broken into its three visible
 * sub-components (creators deposited / withdrew / still hold). Mirrors the
 * balance-sheet snapshot's exact arithmetic on the creator population
 * (`role = 'creator'`, not blacklisted), so `netCash` = −creatorEffect and the
 * bridge ties out by construction. The blacklist is baked into the cache key
 * so an exclusion change can't serve a stale value; tagged with the canonical
 * insights tags. Read-only.
 */
export async function getCreatorNetCashDetail(): Promise<CreatorNetCashDetail> {
  return withTiming("insights.realNumbers.creatorNetCash", async () => {
    const excluded = await getExcludedUserIds();
    // Creators only, minus the admin blacklist — the population the snapshot
    // keeps but the GGR/NGR scope drops. `blacklistNotInClause` escapes the
    // ids defensively; `u.id` is a hardcoded identifier.
    const blacklist = blacklistNotInClause("u.id", excluded);
    const creatorScopeSql = `(SELECT id FROM "user" u WHERE u.role = 'creator' ${blacklist})`;
    return cachedCreatorNetCashDetail(creatorScopeSql);
  });
}

// ─── Customer recycling detail (the bridge "basis" sub-breakdown) ───────
//
// The bridge's "Card-value & re-wager basis" step is the ONE line that is a
// measurement reconciliation, NOT an itemizable cash cost — so its
// "sub-breakdown" is not a list of payments but the recycling MECHANISM that
// explains WHY gaming margin (booked on all turnover at card-sticker values)
// sits far above realized cash (bounded by deposits − withdrawals):
//
//   • customer deposits           — the real cash that ever entered (balances
//                                    .total_deposited, customer scope).
//   • customer total wager         — total turnover the house booked its edge
//                                    on (the SAME getInsightsHubWager the page
//                                    headline shows; borrow-net, sponsored +
//                                    upgrader in, creator-sessions excluded).
//   • card sell-backs to balance   — Σ |card_sale| + |reward_card_sale| (cards
//                                    sold back) + |card_exchange| +
//                                    |exchange_excess_credit| (exchanged for
//                                    credit). The recycling engine: customers
//                                    turn won cards back into balance and re-bet.
//
// All on the canonical real-customer scope (role NOT IN admin/support/creator
// + blacklist), lifetime 365d-capped. These are NEUTRAL ledger conversions
// (CLAUDE.md: card/voucher exchange is a normal user action, NOT a house cost)
// — surfaced here ONLY to show the re-wager multiple, never added to any cost.
// Read-only against the Main DB.

/**
 * The recycling-engine figures behind the bridge's basis line. The customer
 * total WAGER is intentionally NOT here — the page already fetches it via
 * `getInsightsHubWager` (the headline figure) and feeds it straight into the
 * UI, so this detail only adds the two things the page doesn't already have:
 * customer deposits and the card sell-backs that feed the re-wager.
 */
export type CustomerRecyclingDetail = {
  /** Real cash customers ever deposited (balances.total_deposited). */
  deposits: number;
  /** Σ card sell-backs to balance (sales + exchanges) that get re-bet. */
  cardSellBacks: number;
  /** card_sale + reward_card_sale leg (sold back for balance). */
  cardSaleLeg: number;
  /** card_exchange + exchange_excess_credit leg (exchanged for credit). */
  cardExchangeLeg: number;
  /** ISO cutoff of the lifetime window (now − 365d). */
  cutoffIso: string;
  /** The lifetime lookback cap (days) used. */
  lookbackDays: number;
};

const cachedCustomerRecycling = unstable_cache(
  async (
    cutoffIso: string,
    userScopeSql: string,
    sessionWindowsCte: string,
    notInCreatorSessionLedger: string,
  ): Promise<{
    deposits: string;
    cardSaleLeg: string;
    cardExchangeLeg: string;
  }> => {
    const since = `'${cutoffIso}'::timestamptz`;

    const [depRows, sellRows] = await Promise.all([
      // Lifetime cash deposited — the authoritative `balances.total_deposited`
      // counter, customer scope (per-user total; no per-row session filter,
      // exactly like the snapshot's deposit leg).
      queryMainRows<{ deposits: string }[]>(
        `SELECT COALESCE(SUM(total_deposited::numeric), 0)::text AS deposits
         FROM balances WHERE user_id IN ${userScopeSql}`,
      ),
      // Card sell-backs to balance — the NEUTRAL inventory↔balance /
      // voucher↔balance conversions customers re-bet. card_sale +
      // reward_card_sale (sold back) and card_exchange +
      // exchange_excess_credit (exchanged for credit), on the canonical
      // scope + window + creator-session exclusion.
      queryMainRows<{ card_sale: string; card_exchange: string }[]>(
        `WITH ${sessionWindowsCte}
         SELECT
           COALESCE(SUM(CASE WHEN type::text IN ('card_sale','reward_card_sale')
             THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS card_sale,
           COALESCE(SUM(CASE WHEN type::text IN ('card_exchange','exchange_excess_credit')
             THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS card_exchange
         FROM ledger_transactions
         WHERE status = 'completed'
           AND type::text IN ('card_sale','reward_card_sale','card_exchange','exchange_excess_credit')
           AND user_id IN ${userScopeSql}
           AND ${notInCreatorSessionLedger}
           AND created_at >= ${since}`,
      ),
    ]);

    return {
      deposits: depRows[0]?.deposits ?? "0",
      cardSaleLeg: sellRows[0]?.card_sale ?? "0",
      cardExchangeLeg: sellRows[0]?.card_exchange ?? "0",
    };
  },
  ["insights-real-numbers-customer-recycling-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

/**
 * The recycling-engine detail behind the bridge's "Card-value & re-wager
 * basis" line: customer deposits + the card sell-backs that feed the re-wager.
 * The customer total wager (for the re-wager multiple) is the page's
 * already-fetched `getInsightsHubWager` headline — the UI divides by these
 * deposits, so this helper stays a pure, parallel-fetchable read and never
 * re-queries the wager. All sums are on the canonical real-customer scope,
 * lifetime 365d-capped. The scope inputs are baked into the cache key; tagged
 * with the canonical insights tags. Read-only against the Main DB.
 */
export async function getCustomerRecyclingDetail(): Promise<CustomerRecyclingDetail> {
  return withTiming("insights.realNumbers.customerRecycling", async () => {
    const now = bucketedNow();
    const cutoff = new Date(
      now.getTime() - INSIGHTS_HUB_WAGER_LOOKBACK_DAYS * MS_PER_DAY,
    );
    const cutoffIso = cutoff.toISOString();

    const scope = await getMetricsScope();
    const legs = await cachedCustomerRecycling(
      cutoffIso,
      scope.userScopeSql,
      scope.sessionWindowsCte,
      scope.notInCreatorSession("user_id", "created_at"),
    );

    const deposits = toNumber(legs.deposits);
    const cardSaleLeg = toNumber(legs.cardSaleLeg);
    const cardExchangeLeg = toNumber(legs.cardExchangeLeg);
    const cardSellBacks = cardSaleLeg + cardExchangeLeg;

    return {
      deposits,
      cardSellBacks,
      cardSaleLeg,
      cardExchangeLeg,
      cutoffIso,
      lookbackDays: INSIGHTS_HUB_WAGER_LOOKBACK_DAYS,
    };
  });
}

// ─── Creator program cost (what the house actually funds) ───────────────
//
// The GGR → P&L bridge's "Creator net cash" step (−$52.9k) is the NET real
// crypto creators personally withdrew (deposits − withdrawals − holdings) — a
// balance-sheet effect on REALIZED P&L. That is NOT what the owner thinks of as
// "creator costs": the owner's real creator costs are the HOUSE-FUNDED program
// — the gross spend the house puts into running creator content. This helper
// surfaces those gross figures, kept deliberately SEPARATE from (and never
// added into) the cash bridge, so the bridge still ties out to realized P&L.
//
// The components (all lifetime, ALL users — this is house program spend, NOT
// customer revenue, so it is NOT on the customer scope; it mirrors the
// /creators tiles `getTipsSponsorSpend` / `getConvertedFromVouchersTotal`,
// which are likewise unscoped roster-wide figures):
//
//   • Session tips         = Σ|creator_tip| (tips creators send to users from
//                            their fill balance) + Σ|creator_fill_spend_tip|
//                            (creator-funded tips spent from the house fill
//                            pool). Both are house-funded handouts to users.
//   • Conversion vouchers  = Σ vouchers.value WHERE origin='creator_fill_
//                            conversion' — the leftover session "fake" fill
//                            balance creators convert into a real payout
//                            voucher they keep (the realized program payout).
//                            Same source the /creators "Converted" KPI uses.
//   • Leaderboard prizes   = Σ|affiliate_leaderboard_prize| — paid to top
//                            affiliates/creators. ⚠️ ALREADY counted inside the
//                            reward & bonus cost line (it is a REWARD_PAYOUT
//                            member), so it is shown for completeness but
//                            flagged "not additional" and is NOT in the
//                            creator-specific subtotal.
//   • Fill context         = creator_deal_fill_grant + creator_fill_activation
//                            (house-granted "fake" session balance for content)
//                            and creator_fill_forfeiture (returned to the
//                            house, $0 cost). Context only — fill grants are
//                            monopoly money for content, not a real cost; only
//                            the converted vouchers + tips become real cost.
//
// ─── ENUM-SAFETY (CRITICAL) ─────────────────────────────────────────────
// Every `creator_*` ledger type and the voucher `origin` are compared via
// `::text` (not the bare enum). The generated application enums are ahead of the
// live prod enum, so a bare comparison against a label prod doesn't yet carry
// throws 22P02 at PARSE time and takes the whole query down (the documented
// ffa61b5c / creator-fill failure class). `::text` makes it a plain string
// compare that matches zero rows when a label is absent — an honest $0, never
// a crash. Read-only against the Main DB; no bind parameters (fixed literals).

/** The creator-program cost components — gross, House-POV. */
export type CreatorProgramCost = {
  /** Σ|creator_tip| — tips creators send users from their fill balance. */
  creatorTip: number;
  /** Σ|creator_fill_spend_tip| — creator-funded tips from the house fill pool. */
  fillSpendTip: number;
  /** Session tips total = creatorTip + fillSpendTip (a real house cost, rose). */
  sessionTips: number;
  /**
   * Σ vouchers.value WHERE origin='creator_fill_conversion' — leftover session
   * fill balance converted to a real payout voucher creators keep (rose).
   */
  conversionVouchers: number;
  /** Count of conversion vouchers minted — context for the figure. */
  conversionVoucherCount: number;
  /**
   * Σ|affiliate_leaderboard_prize| — leaderboard payments. ALREADY inside the
   * reward & bonus cost line, so flagged "not additional" in the UI and NOT
   * added into the creator-specific subtotal.
   */
  leaderboardPrize: number;
  /** Count of leaderboard-prize ledger rows — context. */
  leaderboardPrizeCount: number;
  /**
   * Creator-SPECIFIC program cost NOT already in the reward line = sessionTips
   * + conversionVouchers (the additive creator cost on top of reward & bonus).
   */
  creatorSpecificSubtotal: number;
  /** Σ|creator_deal_fill_grant| — house-granted "fake" session balance (context). */
  fillGrant: number;
  /** Σ|creator_fill_activation| — activated fill balance for sessions (context). */
  fillActivation: number;
  /** Σ|creator_fill_forfeiture| — fill returned to the house, $0 cost (context). */
  fillForfeiture: number;
};

const cachedCreatorProgramCost = unstable_cache(
  async (): Promise<{
    creatorTip: string;
    fillSpendTip: string;
    leaderboardPrize: string;
    leaderboardPrizeCount: string;
    fillGrant: string;
    fillActivation: string;
    fillForfeiture: string;
    conversionVouchers: string;
    conversionVoucherCount: string;
  }> => {

    // One ledger pass for the tip legs, the leaderboard-prize leg, and the
    // three fill-context legs (all enum-safe via ::text). Lifetime, all users —
    // house program spend is not customer-scoped.
    const ledgerRows = await queryMainRows<
      {
        creator_tip: string;
        fill_spend_tip: string;
        leaderboard_prize: string;
        leaderboard_prize_count: string;
        fill_grant: string;
        fill_activation: string;
        fill_forfeiture: string;
      }[]
    >(`
      SELECT
        COALESCE(SUM(CASE WHEN type::text = 'creator_tip'             THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS creator_tip,
        COALESCE(SUM(CASE WHEN type::text = 'creator_fill_spend_tip'  THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS fill_spend_tip,
        COALESCE(SUM(CASE WHEN type::text = 'affiliate_leaderboard_prize' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS leaderboard_prize,
        COALESCE(SUM(CASE WHEN type::text = 'affiliate_leaderboard_prize' THEN 1 ELSE 0 END), 0)::text AS leaderboard_prize_count,
        COALESCE(SUM(CASE WHEN type::text = 'creator_deal_fill_grant' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS fill_grant,
        COALESCE(SUM(CASE WHEN type::text = 'creator_fill_activation' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS fill_activation,
        COALESCE(SUM(CASE WHEN type::text = 'creator_fill_forfeiture' THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS fill_forfeiture
      FROM ledger_transactions
      WHERE status = 'completed'
        AND type::text IN (
          'creator_tip', 'creator_fill_spend_tip', 'affiliate_leaderboard_prize',
          'creator_deal_fill_grant', 'creator_fill_activation', 'creator_fill_forfeiture'
        )
        -- 365d house-convention cap (CLAUDE.md "Performance & Daten-Laden"):
        -- bounds this lifetime ledger scan instead of an unbounded
        -- full-history sweep. No-op on current data (< 90d old); bounds
        -- pathological future scans. The CH twin caps identically for parity.
        AND created_at >= NOW() - INTERVAL '365 days'
    `);

    // Conversion-voucher value + count from the vouchers table — the SAME
    // origin + value source the /creators "Converted" KPI reads.
    const voucherRows = await queryMainRows<
      { conversion_value: string; conversion_count: string }[]
    >(`
      SELECT
        COALESCE(SUM(value::numeric), 0)::text AS conversion_value,
        COUNT(*)::text AS conversion_count
      FROM vouchers
      WHERE origin::text = 'creator_fill_conversion'
        -- 365d house-convention cap (CLAUDE.md "Performance & Daten-Laden"):
        -- bounds this lifetime scan. No-op on current data (< 90d old). The
        -- CH twin caps identically for parity.
        AND created_at >= NOW() - INTERVAL '365 days'
    `);

    const l = ledgerRows[0] ?? {};
    const v = voucherRows[0] ?? {};
    return {
      creatorTip: l.creator_tip ?? "0",
      fillSpendTip: l.fill_spend_tip ?? "0",
      leaderboardPrize: l.leaderboard_prize ?? "0",
      leaderboardPrizeCount: l.leaderboard_prize_count ?? "0",
      fillGrant: l.fill_grant ?? "0",
      fillActivation: l.fill_activation ?? "0",
      fillForfeiture: l.fill_forfeiture ?? "0",
      conversionVouchers: v.conversion_value ?? "0",
      conversionVoucherCount: v.conversion_count ?? "0",
    };
  },
  ["insights-real-numbers-creator-program-cost-v1"],
  { revalidate: 300, tags: ["insights-analytics", "dashboard-lifetime"] },
);

/**
 * Creator program cost — the GROSS, house-funded creator-program spend
 * (session tips, session conversion vouchers, leaderboard payments) plus the
 * fake-money fill context. Deliberately SEPARATE from the GGR → P&L cash
 * bridge: the bridge's "Creator net cash" (−$52.9k) is the NET real crypto
 * creators withdrew (a realized-P&L balance-sheet effect); these are the GROSS
 * program costs the house funds. Lifetime, all users (house program spend is
 * not customer-scoped). Read-only against the Main DB; cached 5 min.
 */
export async function getCreatorProgramCost(): Promise<CreatorProgramCost> {
  return withTiming("insights.realNumbers.creatorProgramCost", async () => {
    const legs = await cachedCreatorProgramCost();

    const creatorTip = toNumber(legs.creatorTip);
    const fillSpendTip = toNumber(legs.fillSpendTip);
    const sessionTips = creatorTip + fillSpendTip;
    const conversionVouchers = toNumber(legs.conversionVouchers);
    const leaderboardPrize = toNumber(legs.leaderboardPrize);

    return {
      creatorTip,
      fillSpendTip,
      sessionTips,
      conversionVouchers,
      conversionVoucherCount: Number(legs.conversionVoucherCount) || 0,
      leaderboardPrize,
      leaderboardPrizeCount: Number(legs.leaderboardPrizeCount) || 0,
      // Creator-specific cost NOT already in the reward line (leaderboard is in
      // reward, so it is excluded from this additive subtotal).
      creatorSpecificSubtotal: sessionTips + conversionVouchers,
      fillGrant: toNumber(legs.fillGrant),
      fillActivation: toNumber(legs.fillActivation),
      fillForfeiture: toNumber(legs.fillForfeiture),
    };
  });
}
