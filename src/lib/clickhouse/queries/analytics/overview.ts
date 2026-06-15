import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { CH_DB, chDateTime, customerScopeCte, toNumber } from "../_shared";
import {
  getDailyGamingMetricsFromClickHouse,
} from "../window-metrics";
import { getRealizedPnlSnapshotFromClickHouse } from "../realized-pnl";
import {
  getBattleStatsFromClickHouse,
  getPackPopularityFromClickHouse,
} from "./_pack-battle-shared";
import type { MetricWindow } from "@/lib/metrics/queries";
import type { AnalyticsData } from "@/lib/queries/analytics";

/**
 * ClickHouse twin of `getAnalyticsData` (`@/lib/queries/analytics.ts`) — the
 * /analytics OVERVIEW tab bundle. Returns the SAME `AnalyticsData` shape so
 * comparison mode can diff the two engines field-for-field.
 *
 * PARITY (mirrors the canonical Postgres `computeAnalyticsData` exactly):
 *
 *   • ggr / ngr            = Σ of the canonical daily gaming-margin series
 *                            (`getDailyGamingMetricsFromClickHouse`, reused —
 *                            the CH twin of `getDailyGamingMetrics`). Headline =
 *                            Σ daily by construction, identical to PG.
 *   • realizedProfit + the 6-term breakdown = `getRealizedPnlSnapshotFromClickHouse`
 *                            (reused — the lifetime balance-sheet snapshot twin).
 *   • uniqueVisitors       = uniqExact(user_id) over completed ledger rows in window.
 *   • newSignups           = COUNT(*) of `user` rows created in window.
 *   • packWager/battleWager/borrowed = Σ|amount| of pack_opening / battle_bet+
 *                            battle_sponsorship ledger rows (borrowed = the
 *                            description-ILIKE-borrow slice).
 *   • upgraderWager        = Σ upgrader_games.bet_amount in window.
 *   • battleStats          = battle-mode / setting / format / flag / top-pack
 *                            aggregates over `battles`.
 *   • packStats            = top-opened + top-borrowed packs over solo opens.
 *   • daily[]              = per-UTC-day ledger aggregate (wager / visitors /
 *                            median deposit+bet / totals / min-max / reward
 *                            breakdown) merged with signups + the canonical
 *                            per-day ggr/ngr — the SAME 3-way merge the PG twin does.
 *
 * SCOPE (mirrors the PG twin per leg — see analytics.ts):
 *   • aggregates / visitors / dailyTx / topPacks / upgraderWager: wholesale
 *     3-role customer scope (`role NOT IN ('admin','support','creator')`) +
 *     blacklist. (`EXCL_STAFF_FRAG` = `getMetricsScope().exclStaffSessionFrag()`;
 *     creators are dropped wholesale so the session-window carve-out is a no-op
 *     — identical population to `customerScopeCte`.)
 *   • dailySignups: 3-role + blacklist directly on `user`.
 *   • battle* (mode/setting/flags/format/topBattlePacks): `role != 'admin'`
 *     only (support + creators KEPT), NO blacklist — exactly the PG
 *     `battleStaffExcl`.
 *
 * Windows (mirrors `periodToDateFilter` / `periodToMetricWindow` /
 * `battleSinceFragment`): `today` anchors at midnight UTC of the current day;
 * `7d`/`30d`/`90d` are rolling N-day from `now`; `all` has no lower bound.
 *
 * ClickHouse correctness: FINAL + `_peerdb_is_deleted = 0` on EVERY mirrored
 * table; money stays Decimal (`toString(sum(...))` → `toNumber`), never Float.
 * The blacklist is passed in by the caller (no Postgres client imported here).
 *
 * NOTE (daily medians): `avgDeposit`/`avgBet` use `quantileExactIf(0.5)` as the
 * CH analogue of PG `PERCENTILE_CONT(0.5)`. The two engines use a different
 * interpolation rule on even-sized samples, so the per-day median is NOT
 * asserted cent-exact by the comparison module (it is excluded from the drift
 * record); every other daily field (sums / counts / min / max) is exact.
 */

export type OverviewPeriod = "today" | "7d" | "30d" | "90d" | "all";

function periodCutoff(period: OverviewPeriod, now: Date): Date | null {
  if (period === "all") return null;
  if (period === "today") {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  const days = period === "7d" ? 7 : period === "30d" ? 30 : 90;
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

const BET_TYPES_SQL = `('pack_opening','battle_bet','battle_sponsorship')`;
const BATTLE_WAGER_TYPES_SQL = `('battle_bet','battle_sponsorship')`;

type AggRow = {
  pack_wager: string;
  battle_wager: string;
  pack_wager_borrowed: string;
  battle_wager_borrowed: string;
  unique_visitors: string;
};
type UpgRow = { upg_wager: string };
type DailyTxRow = {
  date: string;
  pack_wager: string;
  battle_wager: string;
  unique_visitors: string;
  avg_deposit: string;
  avg_bet: string;
  total_deposit: string;
  total_bet: string;
  min_deposit: string;
  max_deposit: string;
  min_bet: string;
  max_bet: string;
  reward_rakeback: string;
  reward_signup_packs: string;
  reward_leaderboard: string;
  reward_rain: string;
  reward_promo: string;
  reward_affiliate: string;
};
type SignupRow = { date: string; count: string };

export async function getAnalyticsDataFromClickHouse(
  period: OverviewPeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<AnalyticsData> {
  const cutoff = periodCutoff(period, now);
  const metricWindow: MetricWindow = { since: cutoff };
  const hasBlacklist = blacklist.length > 0;
  const realUsers = customerScopeCte({ hasBlacklist });

  const params: Record<string, unknown> = { blacklist };
  if (cutoff !== null) params.cutoff = chDateTime(cutoff);
  const ltCutoff =
    cutoff !== null ? "AND lt.created_at >= {cutoff:DateTime64(6)}" : "";
  const userCutoff =
    cutoff !== null ? "AND u.created_at >= {cutoff:DateTime64(6)}" : "";

  // Headline ledger aggregates + unique visitors (3-role + blacklist).
  const aggSql = `
    WITH ${realUsers}
    SELECT
      toString(sum(if(lt.type = 'pack_opening', abs(lt.amount), toDecimal128(0, 2)))) AS pack_wager,
      toString(sum(if(lt.type IN ${BATTLE_WAGER_TYPES_SQL}, abs(lt.amount), toDecimal128(0, 2)))) AS battle_wager,
      toString(sum(if(lt.type = 'pack_opening' AND lt.description ILIKE '%borrow%', abs(lt.amount), toDecimal128(0, 2)))) AS pack_wager_borrowed,
      toString(sum(if(lt.type = 'battle_bet' AND lt.description ILIKE '%borrow%', abs(lt.amount), toDecimal128(0, 2)))) AS battle_wager_borrowed,
      toString(uniqExact(lt.user_id)) AS unique_visitors
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.user_id IN (SELECT id FROM real_users)
      ${ltCutoff}`;

  const upgSql = `
    WITH ${realUsers}
    SELECT toString(sum(ug.bet_amount)) AS upg_wager
    FROM ${CH_DB}.public_upgrader_games AS ug FINAL
    WHERE ug._peerdb_is_deleted = 0
      AND ug.user_id IN (SELECT id FROM real_users)
      ${cutoff !== null ? "AND ug.created_at >= {cutoff:DateTime64(6)}" : ""}`;

  const dailyTxSql = `
    WITH ${realUsers}
    SELECT
      toString(toDate(lt.created_at)) AS date,
      toString(sum(if(lt.type = 'pack_opening', abs(lt.amount), toDecimal128(0, 2)))) AS pack_wager,
      toString(sum(if(lt.type IN ${BATTLE_WAGER_TYPES_SQL}, abs(lt.amount), toDecimal128(0, 2)))) AS battle_wager,
      toString(uniqExact(lt.user_id)) AS unique_visitors,
      toString(quantileExactIf(0.5)(abs(lt.amount), lt.type = 'deposit')) AS avg_deposit,
      toString(quantileExactIf(0.5)(abs(lt.amount), lt.type IN ${BET_TYPES_SQL})) AS avg_bet,
      toString(sumIf(abs(lt.amount), lt.type = 'deposit')) AS total_deposit,
      toString(sumIf(abs(lt.amount), lt.type IN ${BET_TYPES_SQL})) AS total_bet,
      toString(minIf(abs(lt.amount), lt.type = 'deposit')) AS min_deposit,
      toString(maxIf(abs(lt.amount), lt.type = 'deposit')) AS max_deposit,
      toString(minIf(abs(lt.amount), lt.type IN ${BET_TYPES_SQL})) AS min_bet,
      toString(maxIf(abs(lt.amount), lt.type IN ${BET_TYPES_SQL})) AS max_bet,
      toString(sumIf(abs(lt.amount), lt.type = 'rakeback_claim')) AS reward_rakeback,
      toString(sumIf(abs(lt.amount), lt.type = 'balance_reward_claim')) AS reward_signup_packs,
      toString(sumIf(abs(lt.amount), lt.type = 'race_prize')) AS reward_leaderboard,
      toString(sumIf(abs(lt.amount), lt.type = 'rain_win')) AS reward_rain,
      toString(sumIf(abs(lt.amount), lt.type = 'promo_code_redeemed')) AS reward_promo,
      toString(sumIf(abs(lt.amount), lt.type = 'affiliate_claim')) AS reward_affiliate
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.user_id IN (SELECT id FROM real_users)
      ${ltCutoff}
    GROUP BY toDate(lt.created_at)
    ORDER BY date`;

  const signupsSql = `
    SELECT toString(toDate(u.created_at)) AS date, toString(count()) AS count
    FROM ${CH_DB}.public_user AS u FINAL
    WHERE u._peerdb_is_deleted = 0
      AND u.role NOT IN ('admin','support','creator')
      ${hasBlacklist ? "AND u.id NOT IN {blacklist:Array(String)}" : ""}
      ${userCutoff}
    GROUP BY toDate(u.created_at)
    ORDER BY date`;

  const [
    dailyCanonical,
    realizedPnl,
    aggRows,
    upgRows,
    dailyTxRows,
    signupRows,
    battleStats,
    packStats,
  ] = await Promise.all([
    getDailyGamingMetricsFromClickHouse(metricWindow, blacklist),
    getRealizedPnlSnapshotFromClickHouse(blacklist),
    clickhouseRead.query<AggRow>({ queryName: "analytics.overview.agg", sql: aggSql, params }),
    clickhouseRead.query<UpgRow>({ queryName: "analytics.overview.upgrader", sql: upgSql, params }),
    clickhouseRead.query<DailyTxRow>({ queryName: "analytics.overview.dailyTx", sql: dailyTxSql, params }),
    clickhouseRead.query<SignupRow>({ queryName: "analytics.overview.signups", sql: signupsSql, params }),
    getBattleStatsFromClickHouse(period, now),
    getPackPopularityFromClickHouse(period, blacklist, true, now),
  ]);

  const agg = aggRows[0];

  const canonicalByDate = new Map(dailyCanonical.map((p) => [p.date, p]));
  const ggr = dailyCanonical.reduce((acc, p) => acc + p.ggr, 0);
  const ngr = dailyCanonical.reduce((acc, p) => acc + p.ngr, 0);

  const signupsMap = new Map(
    signupRows.map((d) => [d.date.slice(0, 10), Number(d.count)]),
  );
  const signups = signupRows.reduce((acc, d) => acc + Number(d.count), 0);

  type DailyPoint = AnalyticsData["daily"][number];
  const daily: DailyPoint[] = dailyTxRows.map((d) => {
    const dateStr = d.date.slice(0, 10);
    const canon = canonicalByDate.get(dateStr);
    return {
      date: dateStr,
      ggr: canon?.ggr ?? 0,
      ngr: canon?.ngr ?? 0,
      packWager: toNumber(d.pack_wager),
      battleWager: toNumber(d.battle_wager),
      uniqueVisitors: Number(d.unique_visitors),
      newSignups: signupsMap.get(dateStr) ?? 0,
      avgDeposit: toNumber(d.avg_deposit),
      avgBet: toNumber(d.avg_bet),
      totalDeposit: toNumber(d.total_deposit),
      totalBet: toNumber(d.total_bet),
      minDeposit: toNumber(d.min_deposit),
      maxDeposit: toNumber(d.max_deposit),
      minBet: toNumber(d.min_bet),
      maxBet: toNumber(d.max_bet),
      rewardRakeback: toNumber(d.reward_rakeback),
      rewardSignupPacks: toNumber(d.reward_signup_packs),
      rewardLeaderboard: toNumber(d.reward_leaderboard),
      rewardRain: toNumber(d.reward_rain),
      rewardPromo: toNumber(d.reward_promo),
      rewardAffiliate: toNumber(d.reward_affiliate),
    };
  });

  const zeros = {
    ggr: 0,
    ngr: 0,
    packWager: 0,
    battleWager: 0,
    uniqueVisitors: 0,
    avgDeposit: 0,
    avgBet: 0,
    totalDeposit: 0,
    totalBet: 0,
    minDeposit: 0,
    maxDeposit: 0,
    minBet: 0,
    maxBet: 0,
    rewardRakeback: 0,
    rewardSignupPacks: 0,
    rewardLeaderboard: 0,
    rewardRain: 0,
    rewardPromo: 0,
    rewardAffiliate: 0,
  };

  for (const [dateStr, count] of signupsMap) {
    if (!daily.find((d) => d.date === dateStr)) {
      daily.push({ date: dateStr, ...zeros, newSignups: count });
    }
  }

  const dailyDates = new Set(daily.map((d) => d.date));
  for (const p of dailyCanonical) {
    if (!dailyDates.has(p.date)) {
      daily.push({
        ...zeros,
        date: p.date,
        ggr: p.ggr,
        ngr: p.ngr,
        newSignups: signupsMap.get(p.date) ?? 0,
      });
      dailyDates.add(p.date);
    }
  }

  daily.sort((a, b) => a.date.localeCompare(b.date));

  return {
    ggr,
    ngr,
    realizedProfit: realizedPnl.pnl,
    realizedProfitBreakdown: {
      totalDeposits: realizedPnl.totalDeposited,
      totalWithdrawals: realizedPnl.totalWithdrawn,
      userBalance: realizedPnl.userBalance,
      inventory: realizedPnl.inventory,
      vouchers: realizedPnl.vouchers,
      unclaimedRakeback: realizedPnl.unclaimedRakeback,
    },
    uniqueVisitors: Number(agg?.unique_visitors ?? 0),
    newSignups: signups,
    packWager: toNumber(agg?.pack_wager),
    battleWager: toNumber(agg?.battle_wager),
    upgraderWager: toNumber(upgRows[0]?.upg_wager),
    packWagerBorrowed: toNumber(agg?.pack_wager_borrowed),
    battleWagerBorrowed: toNumber(agg?.battle_wager_borrowed),
    battleStats,
    packStats,
    daily,
  };
}
