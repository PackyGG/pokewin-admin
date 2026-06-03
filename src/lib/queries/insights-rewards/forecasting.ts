import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { blacklistNotInClause } from "@/lib/queries/_blacklist";
import { toNumber } from "@/lib/utils/decimal";
import { resolveRainHouseCost } from "@/lib/metrics";

/**
 * Forecasting — per-category marketing spend trend over the last N
 * days, with a 30d projection extrapolated from the trailing 7d run-rate.
 *
 * Inputs:
 *   - history days  : how far back to render the historical line
 *                     (default 60 days, fixed at the function level
 *                     because the page exposes a single trending chart
 *                     not tied to the period selector)
 *
 * For each reward category:
 *   - dailyHistory  : { date, total } points across the trailing window
 *                     (zero-filled per day so the chart renders without
 *                     gaps)
 *   - trailingSevenAvg : mean daily spend across the last 7 days
 *   - projected30d  : trailingSevenAvg × 30 (rough run-rate forecast)
 *
 * The forecast is intentionally simple — a 7-day moving average run-rate
 * scaled to 30 days. We're showing trend + ballpark, not a black-box ML
 * model. Admins can sanity-check it against the historical line.
 *
 * Cost basis matches the canonical reward model: rain is NETTED per day to
 * its house slice (`max(0, rain_win_day − rain_tip_day)`), `creator_tip`
 * is excluded (RESIDUAL pass-through, not a cost), and a category with NO
 * spend across the whole history is hidden (no line to project).
 */

// Canonical reward ledger types this forecast trends. `creator_tip` is
// excluded (RESIDUAL, not a house cost). `rain_tip` is included so the
// per-day rain house slice can be netted; it is never a category of its
// own (it is the rain FUNDING leg).
const ALL_REWARD_TYPES_SQL = `(
  'deposit_bonus','promo_code_redeemed','gift_card_redeemed',
  'rakeback_claim','affiliate_claim',
  'rain_win','rain_tip','race_prize','balance_reward_claim',
  'waitlist_prize'
)`;

const HISTORY_DAYS = 60;
const FORECAST_DAYS = 30;
const TRAILING_AVG_DAYS = 7;

type CategoryForecastKey =
  | "bonuses"
  | "rakeback"
  | "affiliate"
  | "rainRace"
  | "signupPack"
  | "waitlist";

export type CategoryForecastRow = {
  key: CategoryForecastKey;
  label: string;
  /** Zero-filled daily history series — last HISTORY_DAYS days. */
  dailyHistory: Array<{ date: string; total: number }>;
  /** Mean of the trailing 7 days of dailyHistory. */
  trailingSevenAvg: number;
  /** trailingSevenAvg × 30. Projected spend over the next 30 days. */
  projected30d: number;
};

export type RewardsForecasting = {
  rows: CategoryForecastRow[];
  /** Same labels as `category-spend-breakdown.ts` so the UI is consistent. */
  historyDays: number;
  forecastDays: number;
};

const CATEGORY_LABELS: Record<CategoryForecastKey, string> = {
  bonuses: "Bonuses & Promos",
  rakeback: "Rakeback",
  affiliate: "Affiliate Commissions",
  rainRace: "Rain / Race Prizes",
  signupPack: "Signup / Balance Rewards",
  waitlist: "Waitlist Prizes",
};

async function computeForecasting(
  blacklistIds: string[],
): Promise<RewardsForecasting> {
  const db = await getDb();
  const blacklistSubquery = blacklistNotInClause("id", blacklistIds);

  // Pull per-day per-category totals across the trailing HISTORY_DAYS
  // window. Then JS handles the zero-fill + 7d trailing avg + 30d
  // projection.
  const rows = await db.$queryRawUnsafe<
    { date: Date; category: string; total: string }[]
  >(`
    SELECT
      DATE(lt.created_at) AS date,
      CASE
        WHEN lt.type::text IN ('deposit_bonus','promo_code_redeemed','gift_card_redeemed') THEN 'bonuses'
        WHEN lt.type::text = 'rakeback_claim' THEN 'rakeback'
        WHEN lt.type::text = 'affiliate_claim' THEN 'affiliate'
        WHEN lt.type::text = 'race_prize' THEN 'rainRace'
        -- rain_win / rain_tip kept as separate per-day pseudo-buckets so
        -- the day's rain house slice can be netted before folding into the
        -- rainRace series (canonical per-day net-rain model).
        WHEN lt.type::text = 'rain_win' THEN '__rain_win'
        WHEN lt.type::text = 'rain_tip' THEN '__rain_tip'
        WHEN lt.type::text = 'balance_reward_claim' THEN 'signupPack'
        WHEN lt.type::text = 'waitlist_prize' THEN 'waitlist'
      END AS category,
      COALESCE(SUM(ABS(lt.amount::numeric)), 0)::text AS total
    FROM ledger_transactions lt
    WHERE lt.status = 'completed'
      AND lt.type::text IN ${ALL_REWARD_TYPES_SQL}
      AND lt.created_at >= NOW() - INTERVAL '${HISTORY_DAYS} days'
      AND lt.user_id IN (SELECT id FROM "user" WHERE role NOT IN ('admin', 'support') ${blacklistSubquery})
    GROUP BY 1, 2
    ORDER BY 1 ASC
  `);

  // Bucket per category. rain_win / rain_tip land in a side map keyed by
  // day so the rainRace series can fold in the netted house slice
  // (`max(0, rain_win_day − rain_tip_day)`) on top of any race_prize.
  const seriesByCategory = new Map<CategoryForecastKey, Map<string, number>>();
  const rainByDay = new Map<string, { win: number; tip: number }>();
  for (const r of rows) {
    const day = new Date(r.date).toISOString().split("T")[0];
    const total = toNumber(r.total);
    if (r.category === "__rain_win") {
      const e = rainByDay.get(day) ?? { win: 0, tip: 0 };
      e.win += total;
      rainByDay.set(day, e);
      continue;
    }
    if (r.category === "__rain_tip") {
      const e = rainByDay.get(day) ?? { win: 0, tip: 0 };
      e.tip += total;
      rainByDay.set(day, e);
      continue;
    }
    const key = r.category as CategoryForecastKey;
    if (!(key in CATEGORY_LABELS)) continue;
    if (!seriesByCategory.has(key)) {
      seriesByCategory.set(key, new Map());
    }
    seriesByCategory.get(key)!.set(day, total);
  }
  // Fold per-day net rain into the rainRace series (alongside race_prize).
  if (rainByDay.size > 0) {
    const rainRace = seriesByCategory.get("rainRace") ?? new Map<string, number>();
    for (const [day, legs] of rainByDay) {
      const netRain = resolveRainHouseCost({
        kind: "net",
        rainWinTotal: legs.win,
        rainTipTotal: legs.tip,
      });
      if (netRain > 0) {
        rainRace.set(day, (rainRace.get(day) ?? 0) + netRain);
      }
    }
    seriesByCategory.set("rainRace", rainRace);
  }

  // Zero-fill the date axis so the chart renders without gaps.
  const dateAxis: string[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = HISTORY_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    dateAxis.push(d.toISOString().split("T")[0]);
  }

  const orderedKeys: CategoryForecastKey[] = [
    "bonuses",
    "rakeback",
    "affiliate",
    "rainRace",
    "signupPack",
    "waitlist",
  ];
  const forecastRows: CategoryForecastRow[] = orderedKeys
    .map((key) => {
      const map = seriesByCategory.get(key) ?? new Map();
      const dailyHistory = dateAxis.map((date) => ({
        date,
        total: map.get(date) ?? 0,
      }));
      const trailing = dailyHistory.slice(-TRAILING_AVG_DAYS);
      const trailingSevenAvg =
        trailing.length > 0
          ? trailing.reduce((a, b) => a + b.total, 0) / trailing.length
          : 0;
      return {
        key,
        label: CATEGORY_LABELS[key],
        dailyHistory,
        trailingSevenAvg,
        projected30d: trailingSevenAvg * FORECAST_DAYS,
      };
    })
    // Hide categories with NO spend across the whole history — there is no
    // line to trend and nothing to project, so they would only clutter
    // (e.g. Waitlist Prizes when nothing was ever paid). Categories that
    // had spend earlier but are quiet in the trailing 7d still render (the
    // tab dims them with a "Quiet" badge), so this only drops the
    // genuinely-empty ones.
    .filter((row) => row.dailyHistory.some((p) => p.total > 0));

  return {
    rows: forecastRows.sort((a, b) => b.projected30d - a.projected30d),
    historyDays: HISTORY_DAYS,
    forecastDays: FORECAST_DAYS,
  };
}

// Forecast snapshot is period-agnostic — fixed history + forecast
// horizons. 5 min revalidate so the per-page trending doesn't refire
// on every scroll.
const cachedForecasting = unstable_cache(
  async (blacklistIds: string[]) => computeForecasting(blacklistIds),
  ["insights-rewards-forecasting-v1"],
  { revalidate: 300, tags: ["rewards-analytics", "insights-rewards"] },
);

export async function getRewardsForecasting(): Promise<RewardsForecasting> {
  const blacklist = await getExcludedUserIds();
  return cachedForecasting([...blacklist].sort());
}
