import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import { resolveRainHouseCost } from "@/lib/metrics/formulas";
import { toNumber } from "@/lib/utils/decimal";
import type {
  RewardBreakdownRow,
  RewardCategoryBreakdown,
  RewardCategoryKey,
  RewardsPeriod,
} from "@/lib/queries/rewards-analytics";

import { CH_DB, chDateTime, customerScopeCte } from "../_shared";
import {
  categoryCostPredicateCh,
  daysForRewardsPeriod,
} from "./_shared";

/**
 * ClickHouse twin of `getRewardCategoryBreakdown`
 * (`src/lib/queries/rewards-analytics.ts`) — the per-category drilldown
 * (one call per category; 7 categories on the page).
 *
 * PARITY: GROUP BY the drilldown key over `public_ledger_transactions` (status
 * 'completed') matching the SAME scan predicate the PG twin uses, then
 * label/aggregate in TS with the IDENTICAL transforms (`buildBreakdownRows`).
 * Two bespoke categories:
 *   • `rainRace` — scans race_prize/rain_win/rain_tip; emits a Race prize row +
 *     a Rain (net of tips) row using GLOBAL net rain `max(0, rain_win −
 *     rain_tip)` (NOTE: the breakdown nets GLOBALLY, unlike the Overview leg
 *     which nets PER DAY — each leg mirrors its own PG twin exactly).
 *   • `houseCredits` — buckets manual vouchers vs counted balance credits.
 *
 * SCOPE (mirrors PG EXACTLY): wholesale customer scope
 * `role NOT IN ('admin','support','creator')` + blacklist — `customerScopeCte`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

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

type RawRow = { type: string; total: string; cnt: string };

/** CH twin of `categoryDrilldownGroupExpr`. */
function groupExpr(category: RewardCategoryKey): string {
  if (category === "rainRace") {
    return `multiIf(lt.type = 'race_prize', 'race_prize', lt.type = 'rain_win', '__rain_win', lt.type = 'rain_tip', '__rain_tip', '')`;
  }
  if (category === "houseCredits") {
    return `if(lt.type = 'voucher_redeemed', 'voucher_redeemed', 'admin_balance_adjustment')`;
  }
  return `lt.type`;
}

/** CH twin of `categoryDrilldownScanPredicate`. */
function scanPredicate(category: RewardCategoryKey): string {
  if (category === "rainRace") {
    return `lt.type IN ('race_prize','rain_win','rain_tip')`;
  }
  return categoryCostPredicateCh(category);
}

/** CH twin of `buildBreakdownRows`. */
function buildBreakdownRows(
  category: RewardCategoryKey,
  rows: RawRow[],
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
  return rows
    .filter((r) => r.type != null && r.type !== "")
    .map((r) => ({
      type: r.type,
      label: LEDGER_TYPE_LABELS[r.type] ?? r.type,
      total: toNumber(r.total),
      count: Number(r.cnt),
    }))
    .sort((a, b) => b.total - a.total);
}

export async function getRewardCategoryBreakdownFromClickHouse(
  period: RewardsPeriod,
  category: RewardCategoryKey,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RewardCategoryBreakdown> {
  const days = daysForRewardsPeriod(period);
  const hasBlacklist = blacklist.length > 0;
  const scope = customerScopeCte({ hasBlacklist });

  const params: Record<string, unknown> = { blacklist };
  let dateClause = "";
  if (days !== null) {
    params.cutoff = chDateTime(new Date(now.getTime() - days * DAY_MS));
    dateClause = "AND lt.created_at >= {cutoff:DateTime64(6)}";
  }

  const expr = groupExpr(category);
  const rows = await clickhouseRead.query<RawRow>({
    queryName: "rewards.analytics.category-breakdown",
    sql: `
      WITH ${scope}
      SELECT
        ${expr}                          AS type,
        toString(sum(abs(lt.amount)))    AS total,
        toString(count())                AS cnt
      FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
      WHERE lt._peerdb_is_deleted = 0
        AND lt.status = 'completed'
        AND ${scanPredicate(category)}
        AND lt.user_id IN (SELECT id FROM real_users)
        ${dateClause}
      GROUP BY ${expr}
      ORDER BY type`,
    params,
  });

  const breakdownRows = buildBreakdownRows(category, rows);
  const total = breakdownRows.reduce((a, r) => a + r.total, 0);
  const count = breakdownRows.reduce((a, r) => a + r.count, 0);
  return { category, rows: breakdownRows, total, count };
}
