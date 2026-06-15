import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import { MS_PER_DAY, MS_PER_MINUTE } from "@/lib/utils/time";
import type {
  RealNumbersGameSplit,
  RewardSpendItemization,
  CreatorNetCashDetail,
  CreatorProgramCost,
  RealizedPnlCustomersExclCreators,
  CustomerRecyclingDetail,
} from "@/lib/queries/insights-analytics/real-numbers";

import {
  getRealNumbersComparableFromClickHouse,
  type RealNumbersComparable,
} from "../queries/insights-analytics/real-numbers";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Lifetime lookback cap, inlined as a plain literal to keep the CQRS
 * import-boundary Prisma-free: the canonical
 * `INSIGHTS_HUB_WAGER_LOOKBACK_DAYS` lives in the `server-only`
 * `@/lib/queries/insights-analytics/hub-wager` module, which transitively
 * reaches `getDb`, so value-importing it into this `src/lib/clickhouse/**`
 * file would trip `clickhouse-boundary.test.ts`. Keep in sync (both are 365).
 * Used only for the fallback window when a PG leg failed to expose its
 * `cutoffIso`, plus the daily-pack `obtained_at` floor.
 */
const LIFETIME_LOOKBACK_DAYS = 365;

/**
 * Fire-and-forget comparison for the /insights/real-numbers SOURCE-OF-TRUTH
 * page (Phase 2B). No-op unless the `insights_real_numbers` surface is in
 * `comparison` mode (which is itself forced off whenever ClickHouse is
 * dormant). The ClickHouse twin is fed the SAME canonical 365d cutoffs the
 * Postgres helpers used (carried in each PG result object's `cutoffIso`) and
 * the SAME excluded-users blacklist, so logged drift reflects engine / CDC-lag
 * only, never a window or scope change.
 *
 * The page's cost-breakdown headline + lifetime realized-P&L snapshot have
 * their OWN compare hooks (`compareCostBreakdown`, `compareRealizedPnl`); this
 * hook covers only the real-numbers-specific legs (hub wager, per-game split,
 * reward-spend itemization, customers-excl-creators P&L, creator net cash,
 * customer recycling, creator program cost).
 *
 * Each compared figure is built ONLY from a PG value that actually loaded
 * (null PG legs are skipped, so a failed PG sub-query never logs a false
 * drift). Money fields pass within half a cent; count fields (daily-pack opens
 * / claimers, conversion-voucher count, leaderboard-prize count) must match
 * exactly. Swallows every error via `logError` so the served Postgres payload
 * is never affected (fire-and-forget).
 */
export async function compareRealNumbers(pgValues: {
  /** getInsightsHubWager() — served value (0 fallback on PG failure). */
  hubWager: number;
  split: RealNumbersGameSplit | null;
  rewardSpend: RewardSpendItemization | null;
  pnlExclCreators: RealizedPnlCustomersExclCreators | null;
  creatorNetCash: CreatorNetCashDetail | null;
  creatorProgram: CreatorProgramCost | null;
  recycling: CustomerRecyclingDetail | null;
}): Promise<void> {
  try {
    const mode = await getAdminReadMode("insights_real_numbers");
    if (mode !== "comparison") return;

    // The canonical 365d cutoffs the Postgres helpers used — reused verbatim so
    // each CH leg scans the byte-identical window (no render-time `now` skew).
    // Fall back to the SAME `bucketedNow() − 365d` derivation the PG helpers use
    // when a PG leg failed to load (its cutoffIso is then unavailable).
    const fallbackCutoff = new Date(
      Math.floor(Date.now() / MS_PER_MINUTE) * MS_PER_MINUTE -
        LIFETIME_LOOKBACK_DAYS * MS_PER_DAY,
    );
    const wagerCutoff = pgValues.split
      ? new Date(pgValues.split.cutoffIso)
      : fallbackCutoff;
    const rewardCutoff = pgValues.rewardSpend
      ? new Date(pgValues.rewardSpend.cutoffIso)
      : fallbackCutoff;
    const recyclingCutoff = pgValues.recycling
      ? new Date(pgValues.recycling.cutoffIso)
      : fallbackCutoff;
    // Daily packs scope `obtained_at >= NOW() − 365d` in PG (no bucketing); the
    // 365d-ago boundary makes sub-minute skew immaterial.
    const dailyPacksCutoff = new Date(
      Date.now() - LIFETIME_LOOKBACK_DAYS * MS_PER_DAY,
    );

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRealNumbersComparableFromClickHouse(
        { wagerCutoff, rewardCutoff, recyclingCutoff, dailyPacksCutoff },
        blacklist,
      );
    });

    const pg: Record<string, number> = {};
    const chRecord: Record<string, number> = {};
    const moneyFields: string[] = [];
    const add = (
      field: keyof RealNumbersComparable,
      pgVal: number,
      isMoney: boolean,
    ) => {
      pg[field] = pgVal;
      chRecord[field] = ch[field];
      if (isMoney) moneyFields.push(field);
    };

    // Hub wager — skip a served 0 (a real lifetime wager is never exactly 0,
    // so a 0 is a PG safeQuery fallback, not a comparable value).
    if (pgValues.hubWager > 0) add("hubWager", pgValues.hubWager, true);

    if (pgValues.split) {
      const s = pgValues.split;
      const packs = s.games.find((g) => g.key === "packs");
      const battles = s.games.find((g) => g.key === "battles");
      const upgrader = s.games.find((g) => g.key === "upgrader");
      if (packs) {
        add("packWager", packs.wager, true);
        add("packPayout", packs.payout, true);
      }
      if (battles) {
        add("battleWager", battles.wager, true);
        add("battlePayout", battles.payout, true);
      }
      if (upgrader) {
        add("upgraderWager", upgrader.wager, true);
        add("upgraderPayout", upgrader.payout, true);
      }
      add("splitTotalWager", s.totalWager, true);
      add("splitTotalPayout", s.totalPayout, true);
      add("splitTotalGgr", s.totalGgr, true);
    }

    if (pgValues.rewardSpend) {
      const r = pgValues.rewardSpend;
      add("rewardTotal", r.total, true);
      add("rewardNetRain", r.netRain, true);
      add("rainWinGross", r.rainWinGross, true);
      add("rainTipOffset", r.rainTipOffset, true);
      add("dailyPacksCost", r.dailyPacks.cost, true);
      add("dailyPacksOpens", r.dailyPacks.opens, false);
      add("dailyPacksClaimers", r.dailyPacks.claimers, false);
    }

    if (pgValues.pnlExclCreators) {
      add("pnlExclCreators", pgValues.pnlExclCreators.pnl, true);
    }

    if (pgValues.creatorNetCash) {
      const c = pgValues.creatorNetCash;
      add("creatorDeposited", c.deposited, true);
      add("creatorWithdrawn", c.withdrawn, true);
      add("creatorHoldings", c.holdings, true);
      add("creatorNetCash", c.netCash, true);
    }

    if (pgValues.recycling) {
      const r = pgValues.recycling;
      add("recyclingDeposits", r.deposits, true);
      add("recyclingCardSaleLeg", r.cardSaleLeg, true);
      add("recyclingCardExchangeLeg", r.cardExchangeLeg, true);
      add("recyclingCardSellBacks", r.cardSellBacks, true);
    }

    if (pgValues.creatorProgram) {
      const p = pgValues.creatorProgram;
      add("programCreatorTip", p.creatorTip, true);
      add("programFillSpendTip", p.fillSpendTip, true);
      add("programSessionTips", p.sessionTips, true);
      add("programConversionVouchers", p.conversionVouchers, true);
      add("programConversionVoucherCount", p.conversionVoucherCount, false);
      add("programLeaderboardPrize", p.leaderboardPrize, true);
      add("programLeaderboardPrizeCount", p.leaderboardPrizeCount, false);
      add("programCreatorSpecificSubtotal", p.creatorSpecificSubtotal, true);
      add("programFillGrant", p.fillGrant, true);
      add("programFillActivation", p.fillActivation, true);
      add("programFillForfeiture", p.fillForfeiture, true);
    }

    const drift = computeDrift(pg, chRecord, moneyFields);
    logComparison("insights_real_numbers[lifetime]", drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.insights_real_numbers",
      "comparison failed (ignored)",
      err,
    );
  }
}
