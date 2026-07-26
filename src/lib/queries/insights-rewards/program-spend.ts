import { daysAgoFilter, blacklistNotInSql, queryRows, realCustomersScopeDrizzle, sql } from "@/lib/queries/insights-rewards/_drizzle-query";
import "server-only";

import { unstable_cache } from "next/cache";
import { getDrizzleDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { toNumber } from "@/lib/utils/decimal";
import { resolveRainHouseCost } from "@/lib/metrics";
import { withTiming } from "@/lib/observability/query-timings";
import {
  daysForInsightsPeriodCapped,
  cacheTtlForInsightsPeriod,
  type InsightsRewardsPeriod,
} from "./_period";
import { getDailyPacksGiveaway } from "./daily-packs";

/**
 * program-spend.ts — the reward spend broken down by the PROGRAMS the site
 * actually runs, not by ledger-type family.
 *
 * WHY THIS REPLACES THE CATEGORY BREAKDOWN (owner, 2026-07-23):
 * `category-spend-breakdown.ts` groups by ledger plumbing — "Bonuses &
 * Promos", "Rain / Race Prizes", "Signup / Balance Rewards", "House Credits
 * / Vouchers". Those are implementation buckets: they merge programs that
 * are managed separately (deposit bonus vs a promo code), split ones that
 * aren't, and surface long-dead lines. The owner named the live set:
 *
 *   deposit bonus · rakeback · daily packs · lossback · leaderboards ·
 *   races · tips + sponsorships for creators
 *
 * so that is the spine of this module. Everything else that is still a real
 * house-funded outflow is kept in ONE explicitly-itemised `other` row rather
 * than dropped — silently hiding it would break reconciliation with the
 * canonical `getRewardCost` / cost-breakdown / dashboard figures. `other` is
 * rendered as a secondary line, and it carries its own `components` list so
 * an admin can always see exactly what landed there.
 *
 * ─── PROGRAM → SOURCE MAP (verified against prod, read-only) ─────────
 *
 *   depositBonus  `deposit_bonus` ledger rows
 *                 + `admin_balance_adjustment` credits categorised
 *                   `deposit_bonus` (the manual top-up path)
 *   rakeback      `rakeback_claim`
 *   dailyPacks    `packs.pack_type='reward'` opens — the giveaway value of
 *                 cards handed out for ~$0 wager. No ledger row exists, so
 *                 it comes from `getDailyPacksGiveaway`.
 *   lossback      `admin_balance_adjustment` credits categorised `lossback`
 *   leaderboards  `affiliate_leaderboard_prize`
 *   races         `race_prize`
 *   creatorTips   `creator_fill_spend_tip` + `creator_fill_spend_battle` —
 *                 the HOUSE-funded creator fill pool (tips handed to users,
 *                 battles sponsored). Different SCOPE from the rest (see
 *                 below), so it is its own scan.
 *   other         promo codes, gift cards, signup/balance rewards, waitlist
 *                 prizes, affiliate commissions, net rain, manual vouchers,
 *                 and the remaining counted admin credits (bonus / reload /
 *                 giveaway / bugs / trivia / deposit-problem /
 *                 withdrawal-failed).
 *
 * ─── MODEL RULES CARRIED OVER UNCHANGED ─────────────────────────────
 *
 *  • Rain is NETTED to its house slice `max(0, Σ|rain_win| − Σ|rain_tip|)`
 *    (owner-confirmed) via the canonical `resolveRainHouseCost` — never
 *    counted gross. `rain_tip` is pool FUNDING, never a payout of its own.
 *  • `creator_tip` (user→user) and non-manual `voucher_redeemed` (a voucher
 *    the user already holds becoming balance) are NOT house costs and never
 *    appear here.
 *  • Counted admin-credit categories come from the canonical
 *    `COUNTED_ADJUSTMENT_CATEGORY_KEYS` set — `deposit_bonus` and `lossback`
 *    are lifted OUT of the residual into their own programs; the rest stay
 *    in `other`.
 *
 * ─── SCOPE ──────────────────────────────────────────────────────────
 *
 * The ledger sweep uses `realCustomersScopeDrizzle()` (drops admin / support /
 * creator roles + the admin-managed blacklist) — the canonical customer
 * scope, same as the breakdown it replaces.
 *
 * The creator tips/sponsor scan is BLACKLIST-ONLY, matching
 * `creators/_queries/tips-sponsor-spend.ts` and the dashboard's
 * "Creators Costs" twin: the subject of that spend is the creator who
 * funded it from a house pool, and it is a real house outflow whatever the
 * recipient's role — so dropping creator rows there would zero the line.
 *
 * ─── PERFORMANCE ────────────────────────────────────────────────────
 *
 * Both scans ride `idx_ledger_tx_created_at` (verified by EXPLAIN ANALYZE
 * against prod: Parallel Index Scan, ~120ms for a 30d window). Lifetime
 * (`all`) is capped to `INSIGHTS_LIFETIME_LOOKBACK_DAYS` so it never runs
 * unbounded. Two-layer `unstable_cache` (60s finite / 300s lifetime) keyed
 * on the blacklist signature, same as every other insights-rewards helper.
 *
 * Read-only. House-POV: every program here is money the house GIVES → rose.
 */

// ─── Program identity ───────────────────────────────────────────────

export const REWARD_PROGRAM_KEYS = [
  "depositBonus",
  "rakeback",
  "dailyPacks",
  "lossback",
  "leaderboards",
  "races",
  "creatorTips",
  "other",
] as const;

export type RewardProgramKey = (typeof REWARD_PROGRAM_KEYS)[number];

/** The seven programs the owner named — `other` is the residual, not one. */
export const NAMED_REWARD_PROGRAM_KEYS = REWARD_PROGRAM_KEYS.filter(
  (k) => k !== "other",
) as readonly Exclude<RewardProgramKey, "other">[];

export const REWARD_PROGRAM_LABELS: Record<RewardProgramKey, string> = {
  depositBonus: "Deposit bonus",
  rakeback: "Rakeback",
  dailyPacks: "Daily packs",
  lossback: "Lossback",
  leaderboards: "Leaderboards",
  races: "Races",
  creatorTips: "Creator tips & sponsorships",
  other: "Other house credits",
};

/** One line of plain-English "what this program actually pays for". */
export const REWARD_PROGRAM_BLURBS: Record<RewardProgramKey, string> = {
  depositBonus: "% bonus credited on qualifying deposits, plus manual top-ups.",
  rakeback: "Wager-based rakeback players claim back from their own play.",
  dailyPacks: "Free reward packs — the value of cards handed out for ~$0 wager.",
  lossback: "Discretionary credits returning a share of a player's losses.",
  leaderboards: "Prizes paid out of affiliate / creator leaderboard pools.",
  races: "Wager-race prize pools paid to the top finishers.",
  creatorTips:
    "House-funded creator pool — tips handed to players and sponsored battles.",
  other:
    "Everything else still leaving the house: promo codes, affiliate commissions, rain, manual credits.",
};

// ─── Leaf buckets (SQL) → program (JS) ──────────────────────────────

/**
 * The scan groups by LEAF, not by program, for two reasons: the `other` row
 * needs an itemised component list, and the rain legs must stay separate
 * until they can be netted. The leaf→program fold happens in JS below.
 */
type LeafKey =
  | "depositBonusLedger"
  | "depositBonusAdj"
  | "rakeback"
  | "lossbackAdj"
  | "leaderboardPrize"
  | "racePrize"
  | "promoCode"
  | "giftCard"
  | "balanceReward"
  | "waitlist"
  | "affiliateClaim"
  | "manualVoucher"
  | "adjBonus"
  | "adjReload"
  | "adjGiveaway"
  | "adjOtherCounted"
  | "__rainWin"
  | "__rainTip";

const LEAF_TO_PROGRAM: Record<
  Exclude<LeafKey, "__rainWin" | "__rainTip">,
  RewardProgramKey
> = {
  depositBonusLedger: "depositBonus",
  depositBonusAdj: "depositBonus",
  rakeback: "rakeback",
  lossbackAdj: "lossback",
  leaderboardPrize: "leaderboards",
  racePrize: "races",
  promoCode: "other",
  giftCard: "other",
  balanceReward: "other",
  waitlist: "other",
  affiliateClaim: "other",
  manualVoucher: "other",
  adjBonus: "other",
  adjReload: "other",
  adjGiveaway: "other",
  adjOtherCounted: "other",
};

/** Component labels for the itemised `other` row. */
const LEAF_LABELS: Record<Exclude<LeafKey, "__rainWin" | "__rainTip">, string> =
  {
    depositBonusLedger: "Automatic deposit bonus",
    depositBonusAdj: "Manual deposit-bonus credits",
    rakeback: "Rakeback claims",
    lossbackAdj: "Lossback credits",
    leaderboardPrize: "Leaderboard prizes",
    racePrize: "Race prizes",
    promoCode: "Promo codes",
    giftCard: "Gift cards",
    balanceReward: "Signup / balance rewards",
    waitlist: "Waitlist prizes",
    affiliateClaim: "Affiliate commissions",
    manualVoucher: "House-granted vouchers",
    adjBonus: "Manual bonus credits",
    adjReload: "Reload credits",
    adjGiveaway: "Giveaway credits",
    adjOtherCounted: "Other admin credits",
  };

/**
 * The leaf CASE. Order matters: the two adjustment categories that own a
 * program (`deposit_bonus`, `lossback`) are matched BEFORE the generic
 * counted-adjustment buckets, so they are never swallowed by the residual.
 *
 * `bonus` / `reload` / `giveaway` get named leaves because they carry real
 * money and an admin looking at "Other" should see them by name; every
 * remaining counted category (bugs / trivia / deposit-problem /
 * withdrawal-failed) folds into one `adjOtherCounted` line so the list stays
 * short. Anything that is NOT a house cost — an uncategorised or `other`
 * adjustment, a non-manual voucher, a removal-only debit — falls through to
 * NULL and is dropped by the GROUP BY.
 */
const LEAF_CASE_SQL = `CASE
  WHEN lt.type::text = 'deposit_bonus' THEN 'depositBonusLedger'
  WHEN lt.type::text = 'rakeback_claim' THEN 'rakeback'
  WHEN lt.type::text = 'affiliate_leaderboard_prize' THEN 'leaderboardPrize'
  WHEN lt.type::text = 'race_prize' THEN 'racePrize'
  WHEN lt.type::text = 'promo_code_redeemed' THEN 'promoCode'
  WHEN lt.type::text = 'gift_card_redeemed' THEN 'giftCard'
  WHEN lt.type::text = 'balance_reward_claim' THEN 'balanceReward'
  WHEN lt.type::text = 'waitlist_prize' THEN 'waitlist'
  WHEN lt.type::text = 'affiliate_claim' THEN 'affiliateClaim'
  -- Rain legs stay split so the house slice can be netted in JS.
  WHEN lt.type::text = 'rain_win' THEN '__rainWin'
  WHEN lt.type::text = 'rain_tip' THEN '__rainTip'
  WHEN lt.type::text = 'voucher_redeemed' AND lt.metadata->>'origin' = 'manual' THEN 'manualVoucher'
  WHEN lt.type::text = 'admin_balance_adjustment' AND lt.amount::numeric > 0
       AND lt.metadata->>'adjustment_category' = 'deposit_bonus' THEN 'depositBonusAdj'
  WHEN lt.type::text = 'admin_balance_adjustment' AND lt.amount::numeric > 0
       AND lt.metadata->>'adjustment_category' = 'lossback' THEN 'lossbackAdj'
  WHEN lt.type::text = 'admin_balance_adjustment' AND lt.amount::numeric > 0
       AND lt.metadata->>'adjustment_category' = 'bonus' THEN 'adjBonus'
  WHEN lt.type::text = 'admin_balance_adjustment' AND lt.amount::numeric > 0
       AND lt.metadata->>'adjustment_category' = 'reload' THEN 'adjReload'
  WHEN lt.type::text = 'admin_balance_adjustment' AND lt.amount::numeric > 0
       AND lt.metadata->>'adjustment_category' = 'giveaway' THEN 'adjGiveaway'
  WHEN lt.type::text = 'admin_balance_adjustment' AND lt.amount::numeric > 0
       AND lt.metadata->>'adjustment_category' IN
         ('deposit_problem','withdrawal_failed','bugs','trivia') THEN 'adjOtherCounted'
END`;

/**
 * Every type the sweep has to touch. `type::text` comparison (not a bare
 * enum literal) throughout — the live prod enum is a moving target and an
 * absent literal would throw `22P02` at PARSE time and take the tab down.
 */
const SCANNED_TYPES_SQL = `(
  'deposit_bonus','rakeback_claim','affiliate_leaderboard_prize','race_prize',
  'promo_code_redeemed','gift_card_redeemed','balance_reward_claim','waitlist_prize',
  'affiliate_claim','rain_win','rain_tip','voucher_redeemed','admin_balance_adjustment'
)`;

/** The house-funded creator fill pool — tips + sponsored battles. */
const CREATOR_POOL_TYPES_SQL = `('creator_fill_spend_tip','creator_fill_spend_battle')`;

// ─── Result shape ───────────────────────────────────────────────────

export type RewardProgramComponent = {
  label: string;
  total: number;
  count: number;
};

export type RewardProgramRow = {
  key: RewardProgramKey;
  label: string;
  blurb: string;
  /** House cost in the window (USD). */
  total: number;
  /** Payout events in the window. */
  count: number;
  /** Distinct users who received at least one payout from this program. */
  claimants: number;
  /** % of `grandTotal`. */
  share: number;
  /** total / claimants — average spend per player reached. */
  avgPerClaimant: number;
  /** total / count — average payout size. */
  avgPerPayout: number;
  /** Ascending daily cost points for the sparkline / stacked chart. */
  dailySeries: Array<{ date: string; total: number }>;
  /**
   * Itemised sources. Always populated for `other` (that row is a residual
   * and must be auditable); also populated for `depositBonus`, which has two
   * genuinely different funding paths. Empty for single-source programs.
   */
  components: RewardProgramComponent[];
};

export type RewardProgramBreakdown = {
  /** Every program with spend > 0, biggest first. `other` is always last. */
  rows: RewardProgramRow[];
  /** Σ of all rows — reconciles with the canonical reward cost. */
  grandTotal: number;
  /** Σ of the seven named programs. */
  namedTotal: number;
  /** The residual. `grandTotal − namedTotal`. */
  otherTotal: number;
  /** Distinct programs with any spend in the window. */
  activePrograms: number;
};

// ─── Compute ────────────────────────────────────────────────────────

type LeafAgg = { total: number; count: number; claimants: number };

function emptyLeaf(): LeafAgg {
  return { total: 0, count: 0, claimants: 0 };
}

async function computeProgramSpend(
  period: InsightsRewardsPeriod,
  blacklistIds: string[],
): Promise<RewardProgramBreakdown> {
  return withTiming("insights-rewards.program-spend", async () => {
    const db = await getDrizzleDb();
    const days = daysForInsightsPeriodCapped(period);
    const dateFilter = daysAgoFilter("lt.created_at", days);
    const customerScope = await realCustomersScopeDrizzle();
    // The creator-pool leg is blacklist-only (see header) — build its own
    // exclusion rather than reusing the customer scope, which would drop
    // every creator-funded row.
    const creatorPoolBlacklist = blacklistNotInSql("lt.user_id", blacklistIds);

    const [rollupRows, dailyRows, creatorRows, creatorDailyRows] =
      await Promise.all([
        // 1. Per-leaf rollup — cost / events / distinct claimants.
        queryRows<
          { leaf: string; total: string; cnt: string; claimants: string }[]
        >(db, sql`
          SELECT
            ${sql.raw(LEAF_CASE_SQL)} AS leaf,
            COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total,
            COUNT(*)::text AS cnt,
            COUNT(DISTINCT lt.user_id)::text AS claimants
          FROM ledger_transactions lt
          WHERE lt.status = 'completed'
            AND lt.type::text IN ${sql.raw(SCANNED_TYPES_SQL)}
            AND lt.user_id IN ${customerScope}
            ${dateFilter}
          GROUP BY 1
        `),
        // 2. Per-leaf daily series — drives the sparklines + stacked chart.
        queryRows<{ date: Date; leaf: string; total: string }[]>(db, sql`
          SELECT
            DATE(lt.created_at) AS date,
            ${sql.raw(LEAF_CASE_SQL)} AS leaf,
            COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total
          FROM ledger_transactions lt
          WHERE lt.status = 'completed'
            AND lt.type::text IN ${sql.raw(SCANNED_TYPES_SQL)}
            AND lt.user_id IN ${customerScope}
            ${dateFilter}
          GROUP BY 1, 2
          ORDER BY 1 ASC
        `),
        // 3. Creator pool rollup — blacklist-only scope, split by leg so the
        //    program row can itemise tips vs sponsored battles.
        queryRows<
          { leg: string; total: string; cnt: string; claimants: string }[]
        >(db, sql`
          SELECT
            lt.type::text AS leg,
            COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total,
            COUNT(*)::text AS cnt,
            COUNT(DISTINCT lt.user_id)::text AS claimants
          FROM ledger_transactions lt
          WHERE lt.status = 'completed'
            AND lt.type::text IN ${sql.raw(CREATOR_POOL_TYPES_SQL)}
            ${creatorPoolBlacklist}
            ${dateFilter}
          GROUP BY 1
        `),
        // 4. Creator pool daily series (both legs combined).
        queryRows<{ date: Date; total: string }[]>(db, sql`
          SELECT
            DATE(lt.created_at) AS date,
            COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total
          FROM ledger_transactions lt
          WHERE lt.status = 'completed'
            AND lt.type::text IN ${sql.raw(CREATOR_POOL_TYPES_SQL)}
            ${creatorPoolBlacklist}
            ${dateFilter}
          GROUP BY 1
          ORDER BY 1 ASC
        `),
      ]);

    // ── Fold leaves ──────────────────────────────────────────────────
    const leaves = new Map<LeafKey, LeafAgg>();
    let rainWin = emptyLeaf();
    let rainTip = emptyLeaf();
    for (const r of rollupRows) {
      const agg: LeafAgg = {
        total: toNumber(r.total),
        count: Number(r.cnt),
        claimants: Number(r.claimants),
      };
      if (r.leaf === "__rainWin") {
        rainWin = agg;
        continue;
      }
      if (r.leaf === "__rainTip") {
        rainTip = agg;
        continue;
      }
      if (!(r.leaf in LEAF_TO_PROGRAM)) continue;
      leaves.set(r.leaf as LeafKey, agg);
    }

    // Rain's house slice: max(0, Σ|rain_win| − Σ|rain_tip|). The COUNT and
    // CLAIMANTS stay the rain-WIN figures — netting is a cost adjustment,
    // never a claim that the wins didn't happen.
    const netRain = resolveRainHouseCost({
      kind: "net",
      rainWinTotal: rainWin.total,
      rainTipTotal: rainTip.total,
    });

    // ── Per-program aggregation ──────────────────────────────────────
    const programs = new Map<
      RewardProgramKey,
      {
        total: number;
        count: number;
        claimants: number;
        components: RewardProgramComponent[];
      }
    >();
    const bump = (
      key: RewardProgramKey,
      agg: LeafAgg,
      componentLabel: string | null,
    ) => {
      const cur =
        programs.get(key) ??
        { total: 0, count: 0, claimants: 0, components: [] };
      cur.total += agg.total;
      cur.count += agg.count;
      // Claimant counts across leaves overlap in an unknown way, so summing
      // them would over-count. The program figure is the MAX of its leaves —
      // a guaranteed lower bound that never exceeds the true distinct count,
      // which is the honest direction to err for a "players reached" number.
      cur.claimants = Math.max(cur.claimants, agg.claimants);
      if (componentLabel && agg.total > 0) {
        cur.components.push({
          label: componentLabel,
          total: agg.total,
          count: agg.count,
        });
      }
      programs.set(key, cur);
    };

    for (const [leaf, agg] of leaves) {
      const key = LEAF_TO_PROGRAM[leaf as keyof typeof LEAF_TO_PROGRAM];
      if (!key) continue;
      // Single-source programs don't need a component list that just repeats
      // the row itself; `other` and `depositBonus` do.
      const wantsComponents = key === "other" || key === "depositBonus";
      bump(
        key,
        agg,
        wantsComponents
          ? LEAF_LABELS[leaf as keyof typeof LEAF_LABELS]
          : null,
      );
    }
    if (netRain > 0) {
      bump(
        "other",
        { total: netRain, count: rainWin.count, claimants: rainWin.claimants },
        "Rain (house share)",
      );
    }

    // Creator pool — tips + sponsored battles, itemised.
    for (const r of creatorRows) {
      const agg: LeafAgg = {
        total: toNumber(r.total),
        count: Number(r.cnt),
        claimants: Number(r.claimants),
      };
      bump(
        "creatorTips",
        agg,
        r.leg === "creator_fill_spend_battle"
          ? "Sponsored battles"
          : "Creator tips",
      );
    }

    // Daily packs — inventory giveaway, no ledger row.
    const dailyPacks = await getDailyPacksGiveaway(period);
    if (dailyPacks.giveawayPayout > 0 || dailyPacks.opens > 0) {
      bump(
        "dailyPacks",
        {
          total: dailyPacks.giveawayPayout,
          count: dailyPacks.opens,
          claimants: dailyPacks.claimers,
        },
        null,
      );
    }

    // ── Daily series per program ─────────────────────────────────────
    const seriesByProgram = new Map<RewardProgramKey, Map<string, number>>();
    const addPoint = (key: RewardProgramKey, date: string, total: number) => {
      const m = seriesByProgram.get(key) ?? new Map<string, number>();
      m.set(date, (m.get(date) ?? 0) + total);
      seriesByProgram.set(key, m);
    };
    // Rain is netted PER DAY before it joins the `other` curve, mirroring the
    // canonical per-day net-rain model.
    const rainByDate = new Map<string, { win: number; tip: number }>();
    for (const d of dailyRows) {
      const date = new Date(d.date).toISOString().split("T")[0];
      const total = toNumber(d.total);
      if (d.leaf === "__rainWin" || d.leaf === "__rainTip") {
        const e = rainByDate.get(date) ?? { win: 0, tip: 0 };
        if (d.leaf === "__rainWin") e.win += total;
        else e.tip += total;
        rainByDate.set(date, e);
        continue;
      }
      const key = LEAF_TO_PROGRAM[d.leaf as keyof typeof LEAF_TO_PROGRAM];
      if (!key) continue;
      addPoint(key, date, total);
    }
    for (const [date, legs] of rainByDate) {
      const net = resolveRainHouseCost({
        kind: "net",
        rainWinTotal: legs.win,
        rainTipTotal: legs.tip,
      });
      if (net > 0) addPoint("other", date, net);
    }
    for (const d of creatorDailyRows) {
      addPoint(
        "creatorTips",
        new Date(d.date).toISOString().split("T")[0],
        toNumber(d.total),
      );
    }
    for (const pt of dailyPacks.dailySeries) {
      addPoint("dailyPacks", pt.date, pt.total);
    }

    // ── Assemble ─────────────────────────────────────────────────────
    const grandTotal = [...programs.values()].reduce((a, p) => a + p.total, 0);
    const rows: RewardProgramRow[] = REWARD_PROGRAM_KEYS.map((key) => {
      const p = programs.get(key);
      const total = p?.total ?? 0;
      const count = p?.count ?? 0;
      const claimants = p?.claimants ?? 0;
      return {
        key,
        label: REWARD_PROGRAM_LABELS[key],
        blurb: REWARD_PROGRAM_BLURBS[key],
        total,
        count,
        claimants,
        share: grandTotal > 0 ? (total / grandTotal) * 100 : 0,
        avgPerClaimant: claimants > 0 ? total / claimants : 0,
        avgPerPayout: count > 0 ? total / count : 0,
        dailySeries: [...(seriesByProgram.get(key) ?? new Map())]
          .map(([date, t]) => ({ date, total: t }))
          .sort((a, b) => a.date.localeCompare(b.date)),
        components: (p?.components ?? []).sort((a, b) => b.total - a.total),
      };
    })
      // A program with no spend in the window is dropped — an empty line
      // never earns its row. Applies uniformly, no special cases.
      .filter((r) => r.total > 0)
      // Biggest first, but the residual is always last however large it is:
      // it is context for the named programs, not a program itself.
      .sort((a, b) => {
        if (a.key === "other") return 1;
        if (b.key === "other") return -1;
        return b.total - a.total;
      });

    const otherTotal = rows.find((r) => r.key === "other")?.total ?? 0;
    return {
      rows,
      grandTotal,
      namedTotal: grandTotal - otherTotal,
      otherTotal,
      activePrograms: rows.filter((r) => r.key !== "other").length,
    };
  });
}

// ─── Cached entry-points ────────────────────────────────────────────

const cachedProgramSpend = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeProgramSpend(period, blacklistIds),
  ["insights-rewards-program-spend-v1"],
  { revalidate: 60, tags: ["rewards-analytics", "insights-rewards"] },
);

const cachedProgramSpendLifetime = unstable_cache(
  async (period: InsightsRewardsPeriod, blacklistIds: string[]) =>
    computeProgramSpend(period, blacklistIds),
  ["insights-rewards-program-spend-lifetime-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards"] },
);

export async function getRewardProgramSpend(
  period: InsightsRewardsPeriod,
): Promise<RewardProgramBreakdown> {
  const blacklist = await getExcludedUserIds();
  const sorted = [...blacklist].sort();
  const ttl = cacheTtlForInsightsPeriod(period);
  return ttl >= 300
    ? cachedProgramSpendLifetime(period, sorted)
    : cachedProgramSpend(period, sorted);
}
