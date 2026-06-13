import "server-only";

import { unstable_cache } from "next/cache";

import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { MS_PER_DAY, MS_PER_MINUTE } from "@/lib/utils/time";
import { getMetricsScope } from "@/lib/metrics/scope";
import { upgraderMetrics } from "@/lib/metrics/queries";
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
  key: "packs" | "battles" | "upgrader";
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
  /** Per-product GGR rows in display order (packs, battles, upgrader). */
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
  }> => {
    const db = await getDb();
    const since = `'${cutoffIso}'::timestamptz`;

    type WagerRow = { pack_wager: string; battle_wager: string };
    type InvRow = { pack_inv: string; battle_inv: string };
    type LedgerPayoutRow = { battle_ledger_payout: string };

    const [wagerRows, invRows, ledgerPayoutRows, upg] = await Promise.all([
      // Per-product WAGER from the ledger, under the canonical WAGER_LEG_FILTER
      // (the SAME predicate getGamingLegs applies). pack_opening → packs;
      // battle_bet + battle_sponsorship → battles. battle_sponsorship is
      // counted directly (no borrow gate) exactly as the headline does.
      db.$queryRawUnsafe<WagerRow[]>(
        `WITH ${sessionWindowsCte}
         SELECT
           COALESCE(SUM(CASE WHEN type::text = 'pack_opening'
             THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS pack_wager,
           COALESCE(SUM(CASE WHEN type::text IN ('battle_bet','battle_sponsorship')
             THEN ABS(amount::numeric) ELSE 0 END), 0)::text AS battle_wager
         FROM ledger_transactions
         WHERE status = 'completed'
           AND type::text IN ('pack_opening','battle_bet','battle_sponsorship')
           AND user_id IN ${userScopeSql}
           AND ${notInCreatorSessionLedger}
           AND created_at >= ${since}
           AND ${WAGER_LEG_FILTER}`,
      ),
      // Per-product INVENTORY payout, under the canonical PAYOUT_LEG_FILTER
      // (the SAME predicate getGamingLegs applies). source_type splits the
      // two products; the borrow + reward-pack exclusion is identical.
      db.$queryRawUnsafe<InvRow[]>(
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
      // The LEDGER gaming-payout legs (battle_refund + battle_excess_to_voucher)
      // — both are battle-win settlement legs, so they belong to battles. Same
      // GAMING_PAYOUT_TYPES set + scope getGamingLegs sums; no borrow flag on
      // these legs (summed unconditionally within the type filter), matching
      // the headline.
      db.$queryRawUnsafe<LedgerPayoutRow[]>(
        `WITH ${sessionWindowsCte}
         SELECT
           COALESCE(SUM(ABS(amount::numeric)), 0)::text AS battle_ledger_payout
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
 * Per-product GGR split (packs / battles / upgrader) over the lifetime
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

    const games = [packs, battles, upgrader];
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
    const db = await getDb();
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
    const rows = await db.$queryRawUnsafe<Row[]>(
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
 * `creator_tip` is deliberately ABSENT (it is a RESIDUAL user→user
 * pass-through, not a reward cost — owner decision: creator costs are out of
 * GGR/NGR). Daily / free signup packs are likewise NOT here (a separate
 * giveaway not in getRewardCost).
 */
export async function getRewardSpendItemization(): Promise<RewardSpendItemization> {
  return withTiming("insights.realNumbers.rewardSpend", async () => {
    const now = bucketedNow();
    const cutoff = new Date(
      now.getTime() - INSIGHTS_HUB_WAGER_LOOKBACK_DAYS * MS_PER_DAY,
    );
    const cutoffIso = cutoff.toISOString();

    const scope = await getMetricsScope();
    const legs = await cachedRewardSpend(
      cutoffIso,
      scope.userScopeSql,
      scope.sessionWindowsCte,
      scope.notInCreatorSession("user_id", "created_at"),
    );

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
      cutoffIso,
      lookbackDays: INSIGHTS_HUB_WAGER_LOOKBACK_DAYS,
    };
  });
}
