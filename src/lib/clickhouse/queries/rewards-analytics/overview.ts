import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { resolveRainHouseCost } from "@/lib/metrics/formulas";
import { toNumber } from "@/lib/utils/decimal";
import type {
  RewardCategory,
  RewardCategoryKey,
  RewardRecipientRow,
  RewardsAnalyticsData,
  RewardsDailyPoint,
  RewardsPeriod,
} from "@/lib/queries/rewards-analytics";

import { CH_DB, chDateTime, customerScopeCte } from "../_shared";
import {
  ALL_SCANNED_TYPES_SQL,
  categoryCostPredicateCh,
  daysForRewardsPeriod,
  REWARD_ROW_PRED,
} from "./_shared";

/**
 * ClickHouse twin of `getRewardsAnalytics`
 * (`src/lib/queries/rewards-analytics.ts`) — the /rewards/analytics Overview
 * leg (KPI strip + daily chart + category totals + top recipients).
 *
 * PARITY: per-UTC-day GROUP BY over `public_ledger_transactions` (status
 * 'completed', bounded to ALL_SCANNED_TYPES), summing each category via the
 * SAME predicates the PG twin uses, plus the separate rain_win / rain_tip legs.
 * rainRace is netted PER DAY (`race_prize_day + max(0, rain_win_day −
 * rain_tip_day)`) then summed — byte-identical to the PG model. Top recipients
 * is a top-25 leaderboard over the union reward-row predicate (gross rain_win),
 * with a deterministic `total DESC, user_id ASC` tie-break (PG orders by total
 * DESC only; the tie-break makes the row set stable for parity — §5c).
 *
 * SCOPE (mirrors PG EXACTLY): wholesale customer scope
 * `role NOT IN ('admin','support','creator')` + blacklist — `customerScopeCte`.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0`; money Decimal end-to-end
 * (`toString(sum(...))` → `toNumber`); scale-matched zero branch
 * `toDecimal128(0,2)` so cents never truncate (§5b).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

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

const TOP_RECIPIENTS_LIMIT = 25;

type DayRow = {
  date: string;
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
};

type RecipientRow = {
  user_id: string;
  username: string | null;
  image: string | null;
  total: string;
  cnt: string;
};

/** `toString(sum(if(<pred>, abs(amount), toDecimal128(0,2))))` money sum. */
function sumExpr(pred: string, col: string): string {
  return `toString(sum(if(${pred}, abs(lt.amount), toDecimal128(0, 2)))) AS ${col}`;
}

/** `toString(sum(if(<pred>, 1, 0)))` row count. */
function cntExpr(pred: string, col: string): string {
  return `toString(sum(if(${pred}, 1, 0))) AS ${col}`;
}

export async function getRewardsAnalyticsFromClickHouse(
  period: RewardsPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RewardsAnalyticsData> {
  const days = daysForRewardsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const scope = customerScopeCte({ hasBlacklist });

  const params: Record<string, unknown> = { blacklist };
  let dateClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    dateClause = "AND lt.created_at >= {cutoff:DateTime64(6)}";
  }

  const pBonuses = categoryCostPredicateCh("bonuses");
  const pRakeback = categoryCostPredicateCh("rakeback");
  const pAffiliate = categoryCostPredicateCh("affiliate");
  const pRainRace = categoryCostPredicateCh("rainRace");
  const pSignup = categoryCostPredicateCh("signupPack");
  const pWaitlist = categoryCostPredicateCh("waitlist");
  const pHouse = categoryCostPredicateCh("houseCredits");

  const dailySql = `
    WITH ${scope}
    SELECT
      toString(toDate(lt.created_at)) AS date,
      ${sumExpr(pBonuses, "bonuses")},
      ${sumExpr(pRakeback, "rakeback")},
      ${sumExpr(pAffiliate, "affiliate")},
      ${sumExpr(pRainRace, "rain_race")},
      ${sumExpr(pSignup, "signup_pack")},
      ${sumExpr(pWaitlist, "waitlist")},
      ${sumExpr(pHouse, "house_credits")},
      ${sumExpr("lt.type = 'rain_win'", "rain_win")},
      ${sumExpr("lt.type = 'rain_tip'", "rain_tip")},
      ${cntExpr(pBonuses, "bonuses_n")},
      ${cntExpr(pRakeback, "rakeback_n")},
      ${cntExpr(pAffiliate, "affiliate_n")},
      ${cntExpr(pRainRace, "rain_race_n")},
      ${cntExpr(pSignup, "signup_pack_n")},
      ${cntExpr(pWaitlist, "waitlist_n")},
      ${cntExpr(pHouse, "house_credits_n")},
      ${cntExpr("lt.type = 'rain_win'", "rain_win_n")}
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type IN ${ALL_SCANNED_TYPES_SQL}
      AND lt.user_id IN (SELECT id FROM real_users)
      ${dateClause}
    GROUP BY toDate(lt.created_at)
    ORDER BY date ASC`;

  const recipientsSql = `
    WITH ${scope}
    SELECT
      u.id       AS user_id,
      u.username AS username,
      u.image    AS image,
      toString(sum(if(${REWARD_ROW_PRED}, abs(lt.amount), toDecimal128(0, 2)))) AS total,
      toString(sum(if(${REWARD_ROW_PRED}, 1, 0)))                               AS cnt
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    INNER JOIN ${CH_DB}.public_user AS u FINAL ON u.id = lt.user_id
    WHERE lt._peerdb_is_deleted = 0
      AND u._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.type IN ${ALL_SCANNED_TYPES_SQL}
      AND lt.user_id IN (SELECT id FROM real_users)
      ${dateClause}
    GROUP BY u.id, u.username, u.image
    HAVING sum(if(${REWARD_ROW_PRED}, abs(lt.amount), toDecimal128(0, 2))) > 0
    ORDER BY sum(if(${REWARD_ROW_PRED}, abs(lt.amount), toDecimal128(0, 2))) DESC, u.id ASC
    LIMIT ${TOP_RECIPIENTS_LIMIT}`;

  const [dailyRows, recipientRows] = await Promise.all([
    clickhouseRead.query<DayRow>({
      queryName: "rewards.analytics.overview.daily",
      sql: dailySql,
      params,
    }),
    clickhouseRead.query<RecipientRow>({
      queryName: "rewards.analytics.overview.recipients",
      sql: recipientsSql,
      params,
    }),
  ]);

  const daily: RewardsDailyPoint[] = dailyRows.map((r) => {
    const bonuses = toNumber(r.bonuses);
    const rakeback = toNumber(r.rakeback);
    const affiliate = toNumber(r.affiliate);
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
      date: String(r.date).slice(0, 10),
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
    userId: r.user_id,
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
