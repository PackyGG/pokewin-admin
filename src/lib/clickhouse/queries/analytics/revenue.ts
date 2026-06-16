import "server-only";

import { clickhouseRead } from "@/lib/clickhouse/readonly-query";
import {
  REWARD_PAYOUT_TYPES,
  NEUTRAL_TYPES,
  FEE_TYPES,
  ledgerTypesToSqlList,
  type LedgerTransactionType,
} from "@/lib/metrics/ledger-sets";
import type { MetricWindow } from "@/lib/metrics/queries";
import type { RevenuePeriod } from "@/lib/queries/analytics-revenue";

import { CH_DB, chDateTime, customerScopeCte, toNumber } from "../_shared";
import { getWindowMetricsFromClickHouse } from "../window-metrics";

/**
 * ClickHouse twin of `getRevenueBreakdown`
 * (`src/lib/queries/analytics-revenue.ts`) — the /analytics → Revenue tab.
 *
 * The headline GGR / NGR / gaming-payout / wager come from the validated
 * `getWindowMetricsFromClickHouse` (Phase 2A dashboard_headline_ggr twin), so
 * the hardest, already-proven path is REUSED rather than re-derived. The leg
 * split + the presentational reward / fee / neutral breakdown are added here as
 * focused reads.
 *
 * SCOPE — mirrors the PG twin per leg, with the SAME documented
 * wholesale-vs-session-window approximation the dashboard surfaces use:
 *   • headline GGR/NGR/gamingPayout/wager (`getWindowMetrics`): PG uses the
 *     session-window `getMetricsScope` (creators kept, on-session rows dropped);
 *     the CH window-metrics twin uses the wholesale 3-role drop. Documented,
 *     validated divergence (same as dashboard_headline_ggr).
 *   • inventory-keep payout leg: replicated with the SAME wholesale scope +
 *     PAYOUT_LEG_FILTER as the window-metrics twin's inventory leg, so
 *     `battleRefund = gamingPayout − inventoryPayout` reconciles by construction.
 *   • upgrader wager/payout (`upgraderMetrics`): wholesale 3-role + blacklist —
 *     MATCHES the PG twin exactly (cent-exact).
 *   • reward / fee rows (bonuses / rakeback / affiliate / rain-race / signup-pack
 *     / waitlist / shipping fees): the PG twin sums these from a per-day query
 *     under `realCustomersScopeSql` (wholesale 3-role + blacklist) — MATCHES the
 *     CH wholesale scope exactly (cent-exact).
 *   • neutral + leaderboard-prize rows: the PG twin reads these via
 *     `sumLedgerTypes` (session-window scope, creators kept) — the CH wholesale
 *     scope carries the documented session-window divergence on these two rows.
 *     (The voucher-redeemed row is 0 on BOTH engines by construction:
 *     `rewardSubset("voucher_redeemed")` is empty because `voucher_redeemed` is
 *     NEUTRAL, not a REWARD_PAYOUT type.)
 *
 * Periods: 7d / 30d / 90d / all (lifetime, no lower bound) — `RevenuePeriod`.
 *
 * CH correctness: FINAL + `_peerdb_is_deleted = 0`; money Decimal end-to-end
 * (`toString(sum(...))` → `toNumber`, never Float); conditional zero is
 * `toDecimal128(0, 2)` (§5b). The blacklist is passed in (no Postgres client).
 */

/** Flat money record for the comparison (mirrors the PG `RevenueData` scalars). */
export type RevenueBreakdownCh = {
  // Inflows
  wager: number;
  upgraderWager: number;
  shippingFees: number;
  // Gaming payout
  inventoryKeep: number;
  battleRefund: number;
  upgraderPayout: number;
  // Reward / marketing spend
  bonuses: number;
  rakeback: number;
  affiliate: number;
  rainRace: number;
  signupPack: number;
  waitlist: number;
  voucherRedeemed: number;
  leaderboardPrize: number;
  // Neutral
  cardConversions: number;
  // Totals + headline
  totalInflow: number;
  totalGamingPayout: number;
  totalRewardSpend: number;
  totalNeutral: number;
  ggr: number;
  ngr: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

// Lifetime (`all`) capped at 365d to match the PG twin (analytics-revenue.ts
// LIFETIME_LOOKBACK_DAYS) and the house INSIGHTS_LIFETIME_LOOKBACK_DAYS
// convention, so cutover/comparison stays bounded and consistent.
const LIFETIME_LOOKBACK_DAYS = 365;

function daysForPeriod(period: RevenuePeriod): number | null {
  switch (period) {
    case "7d":
      return 7;
    case "30d":
      return 30;
    case "90d":
      return 90;
    case "all":
      return LIFETIME_LOOKBACK_DAYS;
  }
}

function periodToMetricWindow(period: RevenuePeriod, now: Date): MetricWindow {
  const days = daysForPeriod(period);
  if (days === null) return { since: null };
  return { since: new Date(now.getTime() - days * DAY_MS) };
}

// Chart sub-category groupings — drawn from the canonical REWARD_PAYOUT_TYPES /
// NEUTRAL_TYPES partitions so they can never drift from the PG twin's subsets.
const rewardSubset = (
  ...members: LedgerTransactionType[]
): LedgerTransactionType[] =>
  REWARD_PAYOUT_TYPES.filter((t) => members.includes(t));

const BONUS_TYPES = rewardSubset(
  "deposit_bonus",
  "promo_code_redeemed",
  "gift_card_redeemed",
);
const RAKEBACK_TYPES = rewardSubset("rakeback_claim");
const AFFILIATE_TYPES = rewardSubset("affiliate_claim");
const RAIN_RACE_TYPES = rewardSubset("rain_win", "race_prize");
const SIGNUP_PACK_TYPES = rewardSubset("balance_reward_claim");
const WAITLIST_TYPES = rewardSubset("waitlist_prize");
const VOUCHER_REDEEMED_TYPES = rewardSubset("voucher_redeemed");
const LEADERBOARD_PRIZE_TYPES = rewardSubset("affiliate_leaderboard_prize");

/** `sum(if(type IN (...), abs(amount), 0))` for the alias, or a scale-matched 0 for an empty set. */
function sumCol(types: readonly LedgerTransactionType[], alias: string): string {
  if (types.length === 0) {
    return `toString(toDecimal128(0, 2)) AS ${alias}`;
  }
  return `toString(sum(if(lt.type IN ${ledgerTypesToSqlList(
    types,
  )}, abs(lt.amount), toDecimal128(0, 2)))) AS ${alias}`;
}

/**
 * Reward-pack session set — `game_sessions` for reward-pack opens. Mirrors
 * `REWARD_PACK_SESSIONS` / the window-metrics twin's inventory-leg exclusion.
 */
const REWARD_PACK_SESSIONS = `(
        SELECT gs.id
        FROM ${CH_DB}.public_game_sessions AS gs FINAL
        INNER JOIN ${CH_DB}.public_packs AS p FINAL
          ON p.id = gs.game_id AND p._peerdb_is_deleted = 0 AND p.pack_type = 'reward'
        WHERE gs._peerdb_is_deleted = 0
          AND gs.game_type = 'pack'
      )`;

export async function getRevenueBreakdownFromClickHouse(
  period: RevenuePeriod,
  blacklist: string[],
  now: Date = new Date(),
): Promise<RevenueBreakdownCh> {
  const hasBlacklist = blacklist.length > 0;
  const metricWindow = periodToMetricWindow(period, now);
  const since = metricWindow.since;
  const params: Record<string, unknown> = { blacklist };
  if (since !== null) params.cutoff = chDateTime(since);
  const sinceLedger =
    since !== null ? "AND lt.created_at >= {cutoff:DateTime64(6)}" : "";
  const sinceInv =
    since !== null ? "AND ui.obtained_at >= {cutoff:DateTime64(6)}" : "";
  const sinceUpg =
    since !== null ? "AND ug.created_at >= {cutoff:DateTime64(6)}" : "";

  const scope = customerScopeCte({ hasBlacklist });

  // Inventory-keep payout leg — identical to the window-metrics twin's inv leg
  // so battleRefund = gamingPayout − inventoryKeep reconciles by construction.
  const invSql = `
    WITH ${scope}
    SELECT toString(sum(ui.value_at_obtained)) AS inv_payout
    FROM ${CH_DB}.public_user_inventory AS ui FINAL
    WHERE ui._peerdb_is_deleted = 0
      AND ui.source_type IN ('pack','battle')
      AND (ui.source_id IS NULL OR ui.source_id NOT IN ${REWARD_PACK_SESSIONS})
      AND ui.user_id IN (SELECT id FROM real_users)
      ${sinceInv}`;

  // Upgrader leg (wholesale 3-role + blacklist — matches PG upgraderMetrics).
  const upgSql = `
    WITH ${scope}
    SELECT
      toString(sum(ug.bet_amount)) AS upg_wager,
      toString(sum(ug.won_amount)) AS upg_payout
    FROM ${CH_DB}.public_upgrader_games AS ug FINAL
    WHERE ug._peerdb_is_deleted = 0
      AND ug.user_id IN (SELECT id FROM real_users)
      ${sinceUpg}`;

  // Reward / fee / neutral presentational rows — one wholesale ledger scan with
  // conditional sums over the canonical type subsets (matches the PG twin's
  // per-day breakdown + sumLedgerTypes legs; see the scope note in the header).
  const breakdownSql = `
    WITH ${scope}
    SELECT
      ${sumCol(FEE_TYPES, "shipping_fees")},
      ${sumCol(BONUS_TYPES, "bonuses")},
      ${sumCol(RAKEBACK_TYPES, "rakeback")},
      ${sumCol(AFFILIATE_TYPES, "affiliate")},
      ${sumCol(RAIN_RACE_TYPES, "rain_race")},
      ${sumCol(SIGNUP_PACK_TYPES, "signup_pack")},
      ${sumCol(WAITLIST_TYPES, "waitlist")},
      ${sumCol(VOUCHER_REDEEMED_TYPES, "voucher_redeemed")},
      ${sumCol(LEADERBOARD_PRIZE_TYPES, "leaderboard_prize")},
      ${sumCol(NEUTRAL_TYPES, "neutral_total")}
    FROM ${CH_DB}.public_ledger_transactions AS lt FINAL
    WHERE lt._peerdb_is_deleted = 0
      AND lt.status = 'completed'
      AND lt.user_id IN (SELECT id FROM real_users)
      ${sinceLedger}`;

  type InvRow = { inv_payout: string };
  type UpgRow = { upg_wager: string; upg_payout: string };
  type BreakdownRow = {
    shipping_fees: string;
    bonuses: string;
    rakeback: string;
    affiliate: string;
    rain_race: string;
    signup_pack: string;
    waitlist: string;
    voucher_redeemed: string;
    leaderboard_prize: string;
    neutral_total: string;
  };

  const [windowMetrics, invRows, upgRows, breakdownRows] = await Promise.all([
    getWindowMetricsFromClickHouse(metricWindow, blacklist),
    clickhouseRead.query<InvRow>({
      queryName: "analytics.revenue.inventory",
      sql: invSql,
      params,
    }),
    clickhouseRead.query<UpgRow>({
      queryName: "analytics.revenue.upgrader",
      sql: upgSql,
      params,
    }),
    clickhouseRead.query<BreakdownRow>({
      queryName: "analytics.revenue.breakdown",
      sql: breakdownSql,
      params,
    }),
  ]);

  const inventoryKeep = toNumber(invRows[0]?.inv_payout);
  const upgraderWager = toNumber(upgRows[0]?.upg_wager);
  const upgraderPayout = toNumber(upgRows[0]?.upg_payout);

  const b = breakdownRows[0];
  const shippingFees = toNumber(b?.shipping_fees);
  const bonuses = toNumber(b?.bonuses);
  const rakeback = toNumber(b?.rakeback);
  const affiliate = toNumber(b?.affiliate);
  const rainRace = toNumber(b?.rain_race);
  const signupPack = toNumber(b?.signup_pack);
  const waitlist = toNumber(b?.waitlist);
  const voucherRedeemed = toNumber(b?.voucher_redeemed);
  const leaderboardPrize = toNumber(b?.leaderboard_prize);
  const cardConversions = toNumber(b?.neutral_total);

  // legs.wager is the upgrader-folded wager (= windowMetrics.wager). The PG
  // inflows list shows it alongside a SEPARATE upgrader_wager row, so totalInflow
  // double-counts upgrader exactly like the PG twin — replicated here.
  const wager = windowMetrics.wager;
  const totalGamingPayout = windowMetrics.gamingPayout;
  const battleRefund = totalGamingPayout - inventoryKeep;

  const totalInflow = wager + upgraderWager + shippingFees;
  const totalRewardSpend =
    bonuses +
    rakeback +
    affiliate +
    rainRace +
    signupPack +
    waitlist +
    voucherRedeemed +
    leaderboardPrize;

  return {
    wager,
    upgraderWager,
    shippingFees,
    inventoryKeep,
    battleRefund,
    upgraderPayout,
    bonuses,
    rakeback,
    affiliate,
    rainRace,
    signupPack,
    waitlist,
    voucherRedeemed,
    leaderboardPrize,
    cardConversions,
    totalInflow,
    totalGamingPayout,
    totalRewardSpend,
    totalNeutral: cardConversions,
    ggr: windowMetrics.ggr,
    ngr: windowMetrics.ngr,
  };
}
