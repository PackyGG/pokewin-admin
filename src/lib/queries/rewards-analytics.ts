import { queryMainRows } from "@/lib/drizzle-query";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "./_blacklist";
import { countedAdjustmentSqlPredicate } from "@/lib/balance-adjustment-categories";
import { resolveRainHouseCost } from "@/lib/metrics";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Rewards-cost analytics — drives /rewards/analytics (Overview) and, via
 * the per-category breakdown helpers, the drilldown popovers + the
 * /insights/rewards Categories tab reuse.
 *
 * CANONICAL DEFINITION (mirrors `src/lib/metrics/queries.ts` `getRewardCost`
 * — the single source of truth for "what a reward cost is"; do NOT diverge):
 *
 *   reward cost = Σ|amount| over REWARD_PAYOUT_TYPES EXCLUDING rain_win
 *               + manual-voucher carve-out:  `voucher_redeemed` rows WHERE
 *                 metadata->>'origin' = 'manual' (admin house-granted
 *                 vouchers whose ONLY ledger touchpoint is the redemption)
 *               + counted-adjustment carve-out: `admin_balance_adjustment`
 *                 CREDITS carrying a COUNTED category
 *                 (`countedAdjustmentSqlPredicate()` — deposit_problem /
 *                 giveaway / bonus / deposit_bonus / bugs / reload /
 *                 lossback)
 *               + NET rain:  max(0, Σ|rain_win| − Σ|rain_tip|)
 *
 * REWARD_PAYOUT_TYPES (from `@/lib/metrics`): deposit_bonus, rakeback_claim,
 * gift_card_redeemed, promo_code_redeemed, race_prize, rain_win,
 * waitlist_prize, balance_reward_claim, affiliate_claim,
 * affiliate_leaderboard_prize.
 *
 * `creator_tip` is NOT a reward cost — it is a verified user→user
 * pass-through (RESIDUAL). Counting it would fabricate a house expense
 * that does not exist (owner decision: creator costs stay OUT of customer
 * GGR/NGR). It is deliberately absent from every category below.
 *
 * Non-manual `voucher_redeemed` / voucher-exchange / card-conversion rows
 * are NEUTRAL (value already booked at production) and never appear.
 *
 * House-POV (CLAUDE.md): every amount here is money the house GIVES users
 * → a house cost → renders ROSE everywhere.
 *
 * SCOPE: real customers only — staff AND creators dropped
 * (`role NOT IN ('admin','support','creator')`) plus the admin
 * `excluded_users` blacklist. This is the canonical customer scope
 * (`getMetricsScope`); the old `role NOT IN ('admin','support')` shape
 * leaked creator reward rows into the customer total.
 *
 * All amounts use ABS(amount::numeric) so they read as positive cost
 * magnitudes; rain is the one category netted (cost-only adjustment).
 */

export type RewardsPeriod = "today" | "7d" | "30d" | "all";

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
 * Parse a free-string period from a client component / server action
 * payload into the canonical `RewardsPeriod` union. Falls back to the
 * page default (`30d`) so an unknown / tampered value never crashes the
 * action. Mirror of the parser inside the analytics page.
 */
export function parseRewardsPeriod(value: string | undefined): RewardsPeriod {
  switch (value) {
    case "today":
    case "7d":
    case "30d":
    case "all":
      return value;
    default:
      return "30d";
  }
}

/**
 * Stable category keys used across KPIs, the type breakdown + the chart.
 *
 * `creatorTip` was REMOVED (it is a residual pass-through, not a reward
 * cost). `houseCredits` was ADDED — the manual-voucher + counted-adjustment
 * carve-outs of the canonical definition (admin house-granted vouchers +
 * categorized balance credits like bonus / giveaway / reload / lossback /
 * deposit-fix). `affiliate_leaderboard_prize` now folds into the existing
 * `affiliate` category (it is an affiliate cost).
 */
export type RewardCategoryKey =
  | "bonuses"
  | "rakeback"
  | "affiliate"
  | "rainRace"
  | "signupPack"
  | "waitlist"
  | "houseCredits";

export type RewardCategory = {
  key: RewardCategoryKey;
  label: string;
  total: number;
  count: number;
  /** Share of total reward cost in the period (0–100). */
  share: number;
};

export type RewardsDailyPoint = {
  date: string;
  bonuses: number;
  rakeback: number;
  affiliate: number;
  rainRace: number;
  signupPack: number;
  waitlist: number;
  houseCredits: number;
  /** Sum of all reward categories on this day. */
  total: number;
};

export type RewardRecipientRow = {
  userId: string;
  username: string | null;
  image: string | null;
  /** Total reward cost paid to this user in the period. */
  total: number;
  /** Number of reward ledger rows for this user in the period. */
  count: number;
};

export type RewardsAnalyticsData = {
  period: RewardsPeriod;
  totalCost: number;
  totalCount: number;
  categories: RewardCategory[];
  daily: RewardsDailyPoint[];
  topRecipients: RewardRecipientRow[];
};

const TOP_RECIPIENTS_LIMIT = 25;

const CATEGORY_LABELS: Record<RewardCategoryKey, string> = {
  bonuses: "Bonuses & Promos",
  rakeback: "Rakeback",
  affiliate: "Affiliate Commissions",
  rainRace: "Rain / Race Prizes",
  signupPack: "Signup / Balance Rewards",
  waitlist: "Waitlist Prizes",
  houseCredits: "House Credits / Vouchers",
};

const CATEGORY_KEYS: readonly RewardCategoryKey[] = [
  "bonuses",
  "rakeback",
  "affiliate",
  "rainRace",
  "signupPack",
  "waitlist",
  "houseCredits",
];

/**
 * Per-category mapping from the stable UI category key to the exact
 * ledger types it sums. Single source of truth for the breakdown helper,
 * the top-recipients helper, the top-promo-codes helper, and any new
 * drilldown surface. Adding a new ledger type to a category here
 * automatically propagates to every type-list-driven drilldown.
 *
 * `affiliate` carries BOTH `affiliate_claim` (commission) AND
 * `affiliate_leaderboard_prize` (the affiliate-leaderboard payout) so the
 * affiliate cost reconciles with the canonical reward set.
 *
 * Two categories are NOT pure ledger-type lists and so map to an EMPTY
 * type list here — they are computed via {@link categoryCostExpr} /
 * {@link categoryDrilldownRows} with bespoke SQL instead:
 *   • `rainRace` — `race_prize` PLUS the NET rain house slice
 *     (`max(0, rain_win − rain_tip)`), which a plain `type IN (...)` ABS
 *     sum cannot express (it would count gross rain and the rain_tip
 *     funding leg).
 *   • `houseCredits` — the manual-voucher (`voucher_redeemed` origin
 *     manual) + counted-adjustment carve-outs, which are per-ROW metadata
 *     splits, not whole ledger types.
 */
const CATEGORY_TO_TYPES: Record<RewardCategoryKey, readonly string[]> = {
  bonuses: ["deposit_bonus", "promo_code_redeemed", "gift_card_redeemed"],
  rakeback: ["rakeback_claim"],
  affiliate: ["affiliate_claim", "affiliate_leaderboard_prize"],
  // rainRace + houseCredits are bespoke (see categoryCostExpr) — no flat
  // type list. race_prize is summed inside the rainRace expression.
  rainRace: [],
  signupPack: ["balance_reward_claim"],
  waitlist: ["waitlist_prize"],
  houseCredits: [],
};

/** Friendly labels for the ledger types that show up in drilldown rows. */
const LEDGER_TYPE_LABELS: Record<string, string> = {
  deposit_bonus: "Deposit bonus",
  promo_code_redeemed: "Promo code",
  gift_card_redeemed: "Gift card",
  rakeback_claim: "Rakeback claim",
  affiliate_claim: "Affiliate claim",
  affiliate_leaderboard_prize: "Affiliate leaderboard prize",
  race_prize: "Race prize",
  rain_win: "Rain win (net of tips)",
  balance_reward_claim: "Balance reward claim",
  waitlist_prize: "Waitlist prize",
  voucher_redeemed: "Manual vouchers",
  admin_balance_adjustment: "Counted balance credits",
};

/**
 * Inline-quote a list of hardcoded ledger type strings into a SQL `IN
 * (...)` fragment. Inputs are NEVER user-supplied — they come from the
 * `CATEGORY_TO_TYPES` map above, which is a literal constant — so this
 * is a simple `.map(...).join(",")` with single-quote escaping as
 * defence-in-depth.
 */
function typeListSql(types: readonly string[]): string {
  return `(${types.map((t) => `'${t.replace(/'/g, "''")}'`).join(",")})`;
}

/**
 * Per-category SQL boolean predicate (for `SUM(CASE WHEN <pred> THEN
 * ABS(amount) END)` / `COUNT(*) FILTER (WHERE <pred>)`). All categories
 * EXCEPT rain (which needs JS netting) reduce to one predicate so the
 * headline aggregate, the daily series and the breakdown all share the
 * exact same row-matching logic.
 *
 *   • Pure type-list categories → `type::text IN (...)`.
 *   • `rainRace` → `race_prize` only HERE; the net rain slice is added in
 *     JS from the separate rain_win / rain_tip legs (see callers).
 *   • `houseCredits` → manual vouchers + counted adjustments.
 *
 * `alias` prefixes the columns (e.g. `lt`); pass `""` for unaliased.
 */
function categoryCostPredicate(category: RewardCategoryKey, alias = ""): string {
  const p = alias ? `${alias}.` : "";
  if (category === "rainRace") {
    return `${p}type::text = 'race_prize'`;
  }
  if (category === "houseCredits") {
    const countedAdj = countedAdjustmentSqlPredicate({
      typeColumn: `${p}type`,
      metadataColumn: `${p}metadata`,
      amountColumn: `${p}amount`,
    });
    return `((${p}type::text = 'voucher_redeemed' AND ${p}metadata->>'origin' = 'manual') OR (${countedAdj}))`;
  }
  const types = CATEGORY_TO_TYPES[category];
  return `${p}type::text IN ${typeListSql(types)}`;
}

/**
 * The set of ledger types that any category's rows could come from, as a
 * single SQL `IN (...)` used to bound the headline / daily scans. Includes
 * `rain_win` + `rain_tip` (for net rain), `race_prize`, every flat
 * category type, `voucher_redeemed` (manual carve-out) and
 * `admin_balance_adjustment` (counted carve-out). The per-category
 * predicates then partition rows inside this scan.
 */
const ALL_SCANNED_TYPES_SQL = typeListSql([
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

export async function getRewardsAnalytics(
  period: RewardsPeriod,
): Promise<RewardsAnalyticsData> {
  const days = daysForPeriod(period);
  const dateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const excluded = await getExcludedUserIds();
  // Canonical real-customer scope: drop staff + creators + blacklist.
  const blacklistSubquery = blacklistNotInClause("id", excluded);
  const blacklistJoinAlias = blacklistNotInClause("u.id", excluded);
  const customerScope = `(SELECT id FROM "user" WHERE role NOT IN ('admin', 'support', 'creator') ${blacklistSubquery})`;

  // Per-category SUM / COUNT expressions. rainRace is handled via the
  // separate rain_win/rain_tip legs (netted in JS) + race_prize here;
  // houseCredits via its bespoke predicate.
  const sumExpr = (cat: RewardCategoryKey, col: string) =>
    `COALESCE(SUM(CASE WHEN ${categoryCostPredicate(cat, "lt")} THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS ${col}`;
  const cntExpr = (cat: RewardCategoryKey, col: string) =>
    `COUNT(*) FILTER (WHERE ${categoryCostPredicate(cat, "lt")})::text AS ${col}`;

  const [dailyRows, recipientRows] = await Promise.all([
    queryMainRows<
      {
        date: Date | string;
        bonuses: string;
        rakeback: string;
        affiliate: string;
        rain_race: string;
        signup_pack: string;
        waitlist: string;
        house_credits: string;
        rain_win: string;
        rain_tip: string;
        bonuses_n: string;
        rakeback_n: string;
        affiliate_n: string;
        rain_race_n: string;
        signup_pack_n: string;
        waitlist_n: string;
        house_credits_n: string;
        rain_win_n: string;
      }[]
    >(`
      SELECT
        DATE(lt.created_at) AS date,
        ${sumExpr("bonuses", "bonuses")},
        ${sumExpr("rakeback", "rakeback")},
        ${sumExpr("affiliate", "affiliate")},
        ${sumExpr("rainRace", "rain_race")},
        ${sumExpr("signupPack", "signup_pack")},
        ${sumExpr("waitlist", "waitlist")},
        ${sumExpr("houseCredits", "house_credits")},
        COALESCE(SUM(CASE WHEN lt.type::text = 'rain_win' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS rain_win,
        COALESCE(SUM(CASE WHEN lt.type::text = 'rain_tip' THEN ABS(lt.amount::numeric) ELSE 0 END), 0)::text AS rain_tip,
        ${cntExpr("bonuses", "bonuses_n")},
        ${cntExpr("rakeback", "rakeback_n")},
        ${cntExpr("affiliate", "affiliate_n")},
        ${cntExpr("rainRace", "rain_race_n")},
        ${cntExpr("signupPack", "signup_pack_n")},
        ${cntExpr("waitlist", "waitlist_n")},
        ${cntExpr("houseCredits", "house_credits_n")},
        COUNT(*) FILTER (WHERE lt.type::text = 'rain_win')::text AS rain_win_n
      FROM ledger_transactions lt
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${ALL_SCANNED_TYPES_SQL}
        AND lt.user_id IN ${customerScope}
        ${dateFilter}
      GROUP BY DATE(lt.created_at)
      ORDER BY date
    `),
    // Top recipients across every reward cost type (same canonical
    // matching as the headline — net rain is a cost adjustment, so the
    // per-user recipient total uses the gross rain_win magnitude for
    // ranking; the headline cost still nets rain).
    queryMainRows<
      {
        id: string;
        username: string | null;
        image: string | null;
        total: string;
        cnt: string;
      }[]
    >(`
      SELECT
        u.id,
        u.username,
        u.image,
        SUM(CASE WHEN ${rewardRowPredicate("lt")} THEN ABS(lt.amount::numeric) ELSE 0 END)::text AS total,
        COUNT(*) FILTER (WHERE ${rewardRowPredicate("lt")})::text AS cnt
      FROM ledger_transactions lt
      JOIN "user" u ON u.id = lt.user_id
      WHERE lt.status = 'completed'
        AND lt.type::text IN ${ALL_SCANNED_TYPES_SQL}
        AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoinAlias}
        ${dateFilter}
      GROUP BY u.id, u.username, u.image
      HAVING SUM(CASE WHEN ${rewardRowPredicate("lt")} THEN ABS(lt.amount::numeric) ELSE 0 END) > 0
      ORDER BY SUM(CASE WHEN ${rewardRowPredicate("lt")} THEN ABS(lt.amount::numeric) ELSE 0 END) DESC
      LIMIT ${TOP_RECIPIENTS_LIMIT}
    `),
  ]);

  const daily: RewardsDailyPoint[] = dailyRows.map((r) => {
    const bonuses = toNumber(r.bonuses);
    const rakeback = toNumber(r.rakeback);
    const affiliate = toNumber(r.affiliate);
    // rainRace = race_prize (already in r.rain_race) + per-day NET rain.
    const netRain = resolveRainHouseCost({
      kind: "net",
      rainWinTotal: toNumber(r.rain_win),
      rainTipTotal: toNumber(r.rain_tip),
    });
    const rainRace = toNumber(r.rain_race) + netRain;
    const signupPack = toNumber(r.signup_pack);
    const waitlist = toNumber(r.waitlist);
    const houseCredits = toNumber(r.house_credits);
    return {
      date: new Date(r.date).toISOString().split("T")[0],
      bonuses,
      rakeback,
      affiliate,
      rainRace,
      signupPack,
      waitlist,
      houseCredits,
      total:
        bonuses +
        rakeback +
        affiliate +
        rainRace +
        signupPack +
        waitlist +
        houseCredits,
    };
  });

  // Category totals + counts. Amounts come from the daily rows; rainRace
  // is netted PER DAY then summed (mirrors the canonical per-day net-rain
  // model so it reconciles with the daily chart). The rainRace COUNT
  // reflects real reward events (race_prize rows + rain_win rows); netting
  // is a cost adjustment only, never a claim that rain wins did not happen.
  const totals: Record<RewardCategoryKey, { total: number; count: number }> = {
    bonuses: { total: 0, count: 0 },
    rakeback: { total: 0, count: 0 },
    affiliate: { total: 0, count: 0 },
    rainRace: { total: 0, count: 0 },
    signupPack: { total: 0, count: 0 },
    waitlist: { total: 0, count: 0 },
    houseCredits: { total: 0, count: 0 },
  };
  for (const r of dailyRows) {
    totals.bonuses.total += toNumber(r.bonuses);
    totals.bonuses.count += Number(r.bonuses_n);
    totals.rakeback.total += toNumber(r.rakeback);
    totals.rakeback.count += Number(r.rakeback_n);
    totals.affiliate.total += toNumber(r.affiliate);
    totals.affiliate.count += Number(r.affiliate_n);
    // race_prize + per-day net rain.
    const netRain = resolveRainHouseCost({
      kind: "net",
      rainWinTotal: toNumber(r.rain_win),
      rainTipTotal: toNumber(r.rain_tip),
    });
    totals.rainRace.total += toNumber(r.rain_race) + netRain;
    totals.rainRace.count += Number(r.rain_race_n) + Number(r.rain_win_n);
    totals.signupPack.total += toNumber(r.signup_pack);
    totals.signupPack.count += Number(r.signup_pack_n);
    totals.waitlist.total += toNumber(r.waitlist);
    totals.waitlist.count += Number(r.waitlist_n);
    totals.houseCredits.total += toNumber(r.house_credits);
    totals.houseCredits.count += Number(r.house_credits_n);
  }

  const totalCost = Object.values(totals).reduce((a, t) => a + t.total, 0);
  const totalCount = Object.values(totals).reduce((a, t) => a + t.count, 0);

  const categories: RewardCategory[] = CATEGORY_KEYS.map((key) => ({
    key,
    label: CATEGORY_LABELS[key],
    total: totals[key].total,
    count: totals[key].count,
    share: totalCost > 0 ? (totals[key].total / totalCost) * 100 : 0,
  })).sort((a, b) => b.total - a.total);

  const topRecipients: RewardRecipientRow[] = recipientRows.map((r) => ({
    userId: r.id,
    username: r.username,
    image: r.image,
    total: toNumber(r.total),
    count: Number(r.cnt),
  }));

  return {
    period,
    totalCost,
    totalCount,
    categories,
    daily,
    topRecipients,
  };
}

/**
 * SQL boolean matching ANY reward-cost row across all categories (the
 * UNION of every category predicate). Used by the recipient / cross-type
 * leaderboards where the per-category split is not needed but the same
 * row-matching as the headline IS. rain_tip is deliberately NOT matched
 * (it is the rain FUNDING leg, netted out of cost, never a payout to a
 * user); the recipient total uses gross rain_win for ranking.
 */
function rewardRowPredicate(alias = ""): string {
  const p = alias ? `${alias}.` : "";
  const flatTypes = [
    ...CATEGORY_TO_TYPES.bonuses,
    ...CATEGORY_TO_TYPES.rakeback,
    ...CATEGORY_TO_TYPES.affiliate,
    ...CATEGORY_TO_TYPES.signupPack,
    ...CATEGORY_TO_TYPES.waitlist,
    "race_prize",
    "rain_win",
  ];
  const countedAdj = countedAdjustmentSqlPredicate({
    typeColumn: `${p}type`,
    metadataColumn: `${p}metadata`,
    amountColumn: `${p}amount`,
  });
  return `(${p}type::text IN ${typeListSql(flatTypes)} OR (${p}type::text = 'voucher_redeemed' AND ${p}metadata->>'origin' = 'manual') OR (${countedAdj}))`;
}

// ============================================================
// Drilldown helpers — make every rollup on /rewards/analytics
// auditable by surfacing the per-ledger-type breakdown + the
// top recipient list for any category on click. Mirrors the
// GGR breakdown popover pattern shipped on /dashboard.
// ============================================================

export type RewardBreakdownRow = {
  /** Raw ledger type string (e.g. "deposit_bonus") or a synthetic key. */
  type: string;
  /** Human-readable label sourced from `LEDGER_TYPE_LABELS`. */
  label: string;
  /** Sum of ABS(amount) for the period (rain row carries the NET slice). */
  total: number;
  /** Row count for this type in the period. */
  count: number;
};

export type RewardCategoryBreakdown = {
  category: RewardCategoryKey;
  /** Per ledger-type rows, sorted DESC by total. */
  rows: RewardBreakdownRow[];
  /** Sum of all rows — equals the headline category total. */
  total: number;
  /** Sum of all row counts. */
  count: number;
};

/**
 * Per-ledger-type rows that sum to a single category's total. Drives the
 * breakdown popover anchored on each reward KPI tile.
 *
 * For the flat type-list categories this is one GROUP BY type sweep with
 * the same canonical scope the headline uses, so the popover row totals
 * equal the headline tile total by construction. The two bespoke
 * categories return computed logical rows:
 *   • `rainRace` — a "Race prize" row + a "Rain win (net of tips)" row
 *     carrying `max(0, rain_win − rain_tip)`.
 *   • `houseCredits` — a "Manual vouchers" row + a "Counted balance
 *     credits" row.
 *
 * Period-aware. Cheap — one round-trip.
 */
export async function getRewardCategoryBreakdown(
  period: RewardsPeriod,
  category: RewardCategoryKey,
): Promise<RewardCategoryBreakdown> {
  const days = daysForPeriod(period);
  const dateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const excluded = await getExcludedUserIds();
  const blacklistSubquery = blacklistNotInClause("id", excluded);
  const customerScope = `(SELECT id FROM "user" WHERE role NOT IN ('admin', 'support', 'creator') ${blacklistSubquery})`;

  const rows = await queryMainRows<
    { type: string; total: string; cnt: string }[]
  >(`
    SELECT
      ${categoryDrilldownGroupExpr(category)} AS type,
      COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total,
      COUNT(*)::text AS cnt
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND ${categoryDrilldownScanPredicate(category)}
      AND lt.user_id IN ${customerScope}
      ${dateFilter}
    GROUP BY 1
    ORDER BY 1
  `);

  const breakdownRows = buildBreakdownRows(category, rows);
  const total = breakdownRows.reduce((a, r) => a + r.total, 0);
  const count = breakdownRows.reduce((a, r) => a + r.count, 0);
  return { category, rows: breakdownRows, total, count };
}

/**
 * The SQL expression the drilldown groups by. For flat categories this is
 * just `lt.type::text`. For the bespoke categories it buckets the scanned
 * rows into the synthetic row keys so the gross→net rain math (and the
 * voucher/adjustment split) can be applied in JS by {@link buildBreakdownRows}.
 */
function categoryDrilldownGroupExpr(category: RewardCategoryKey): string {
  if (category === "rainRace") {
    return `CASE WHEN lt.type::text = 'race_prize' THEN 'race_prize'
                 WHEN lt.type::text = 'rain_win' THEN '__rain_win'
                 WHEN lt.type::text = 'rain_tip' THEN '__rain_tip' END`;
  }
  if (category === "houseCredits") {
    return `CASE WHEN lt.type::text = 'voucher_redeemed' THEN 'voucher_redeemed'
                 ELSE 'admin_balance_adjustment' END`;
  }
  return `lt.type::text`;
}

/** The WHERE-side scan predicate for a category's drilldown. */
function categoryDrilldownScanPredicate(category: RewardCategoryKey): string {
  if (category === "rainRace") {
    return `lt.type::text IN ('race_prize','rain_win','rain_tip')`;
  }
  // houseCredits + flat categories share the headline predicate exactly.
  return categoryCostPredicate(category, "lt");
}

/** Convert raw drilldown group rows into labelled `RewardBreakdownRow`s. */
function buildBreakdownRows(
  category: RewardCategoryKey,
  rows: { type: string; total: string; cnt: string }[],
): RewardBreakdownRow[] {
  if (category === "rainRace") {
    let racePrize = 0;
    let raceCount = 0;
    let rainWin = 0;
    let rainWinCount = 0;
    let rainTip = 0;
    for (const r of rows) {
      const total = toNumber(r.total);
      const cnt = Number(r.cnt);
      if (r.type === "race_prize") {
        racePrize = total;
        raceCount = cnt;
      } else if (r.type === "__rain_win") {
        rainWin = total;
        rainWinCount = cnt;
      } else if (r.type === "__rain_tip") {
        rainTip = total;
      }
    }
    const netRain = resolveRainHouseCost({
      kind: "net",
      rainWinTotal: rainWin,
      rainTipTotal: rainTip,
    });
    const out: RewardBreakdownRow[] = [];
    if (racePrize > 0 || raceCount > 0) {
      out.push({
        type: "race_prize",
        label: LEDGER_TYPE_LABELS.race_prize,
        total: racePrize,
        count: raceCount,
      });
    }
    if (netRain > 0 || rainWinCount > 0) {
      out.push({
        type: "rain_win",
        label: LEDGER_TYPE_LABELS.rain_win,
        total: netRain,
        count: rainWinCount,
      });
    }
    return out.sort((a, b) => b.total - a.total);
  }
  // Flat + houseCredits: label by type, sort DESC.
  return rows
    .filter((r) => r.type != null)
    .map((r) => ({
      type: r.type,
      label: LEDGER_TYPE_LABELS[r.type] ?? r.type,
      total: toNumber(r.total),
      count: Number(r.cnt),
    }))
    .sort((a, b) => b.total - a.total);
}

export type RewardTopRecipientRow = {
  userId: string;
  username: string | null;
  /** Reward total this user received in the category + period. */
  total: number;
  /** Number of reward ledger rows for this user. */
  count: number;
};

/**
 * Top-N reward recipients inside a single category (or `null` for the
 * site-wide "all rewards" rollup). Drives the lazy expander inside the
 * breakdown popover.
 *
 * GROUP BY user_id over the same filter shape the headline aggregate uses
 * — same window, same status, same staff/creator/blacklist exclusion — so
 * the row totals reconcile to the headline tile. For `rainRace` the
 * per-user total uses gross rain_win (net is a cost-only adjustment, not
 * attributable per recipient). Sorted by total DESC; rows clamped to
 * `limit` (1–50, defensive).
 *
 * NOT cached: heavier than the per-type sweep and only fires on user
 * click (server action).
 */
export async function getRewardCategoryTopRecipients(
  period: RewardsPeriod,
  category: RewardCategoryKey | null,
  limit = 10,
): Promise<RewardTopRecipientRow[]> {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const days = daysForPeriod(period);
  const dateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const excluded = await getExcludedUserIds();
  const blacklistJoin = blacklistNotInClause("u.id", excluded);
  // For the per-user list, rain is matched on gross rain_win (the
  // recipient actually received it); the headline cost still nets rain.
  const predicate =
    category === null
      ? rewardRowPredicate("lt")
      : category === "rainRace"
        ? `lt.type::text IN ('race_prize','rain_win')`
        : categoryCostPredicate(category, "lt");

  const rows = await queryMainRows<
    {
      user_id: string;
      username: string | null;
      total: string;
      cnt: string;
    }[]
  >(`
    SELECT
      u.id AS user_id,
      u.username,
      SUM(ABS(lt.amount::numeric))::text AS total,
      COUNT(*)::text AS cnt
    FROM ledger_transactions lt
    JOIN "user" u ON u.id = lt.user_id
    WHERE lt.status = 'completed'
      AND ${predicate}
      AND u.role NOT IN ('admin', 'support', 'creator') ${blacklistJoin}
      ${dateFilter}
    GROUP BY u.id, u.username
    ORDER BY SUM(ABS(lt.amount::numeric)) DESC
    LIMIT ${safeLimit}
  `);

  return rows.map((r) => ({
    userId: r.user_id,
    username: r.username,
    total: toNumber(r.total),
    count: Number(r.cnt),
  }));
}

export type RewardTopPromoCodeRow = {
  /** Promo code id — links to /promo-codes/<id>. */
  codeId: string;
  /** Human-readable code text from `promo_codes.metadata.code`, or null when missing. */
  code: string | null;
  /** Total USD redeemed for this code in the period. */
  total: number;
  /** Number of redemptions in the period. */
  redemptions: number;
};

/**
 * Top promo codes by total redeemed value in the selected period.
 * Drives the per-code expander inside the Bonuses & Promos popover so
 * admins can see WHICH codes drove the $17k they're looking at — not
 * just the per-type rollup.
 *
 * Joins `promo_code_redemptions` → `ledger_transactions` →
 * `promo_codes`. The redemption row is the canonical source of truth
 * for "which code did this redemption belong to"; the linked ledger
 * tx supplies the credited amount (`ABS(amount)`); the promo_codes
 * row supplies the displayable code text (stored under
 * `metadata.code` since `code_hash` is one-way hashed).
 *
 * Staff + creators + blacklist excluded via the same canonical
 * `user_id IN (...)` subquery shape the rest of the file uses.
 * Defensive limit clamp 1–50.
 *
 * NOT cached — same reasoning as the recipients helper (lazy + heavy).
 */
export async function getRewardsTopPromoCodes(
  period: RewardsPeriod,
  limit = 10,
): Promise<RewardTopPromoCodeRow[]> {
  const safeLimit = Math.max(1, Math.min(limit, 50));
  const days = daysForPeriod(period);
  const dateFilter =
    days !== null ? `AND lt.created_at >= NOW() - INTERVAL '${days} days'` : "";
  const excluded = await getExcludedUserIds();
  const blacklistSubquery = blacklistNotInClause("id", excluded);
  const customerScope = `(SELECT id FROM "user" WHERE role NOT IN ('admin', 'support', 'creator') ${blacklistSubquery})`;

  const rows = await queryMainRows<
    {
      code_id: string;
      code: string | null;
      total: string;
      redemptions: string;
    }[]
  >(`
    SELECT
      pc.id::text AS code_id,
      pc.metadata->>'code' AS code,
      SUM(ABS(lt.amount::numeric))::text AS total,
      COUNT(*)::text AS redemptions
    FROM promo_code_redemptions pcr
    JOIN ledger_transactions lt ON lt.id = pcr.ledger_tx_id
    JOIN promo_codes pc ON pc.id = pcr.promo_code_id
    WHERE lt.status = 'completed'
      AND lt.type::text = 'promo_code_redeemed'
      AND lt.user_id IN ${customerScope}
      ${dateFilter}
    GROUP BY pc.id, pc.metadata->>'code'
    ORDER BY SUM(ABS(lt.amount::numeric)) DESC
    LIMIT ${safeLimit}
  `);

  return rows.map((r) => ({
    codeId: r.code_id,
    code: r.code,
    total: toNumber(r.total),
    redemptions: Number(r.redemptions),
  }));
}
