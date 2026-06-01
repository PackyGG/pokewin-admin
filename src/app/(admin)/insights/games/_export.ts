import "server-only";

import type { ExportSection } from "@/lib/utils/export-csv";
import {
  labelForPeriod,
  type GamesPeriod,
} from "@/lib/queries/insights-games/_shared";
import { getGamesOverview } from "@/lib/queries/insights-games/overview";
import { getPacksProfitability } from "@/lib/queries/insights-games/packs";
import { getBattlesProfitability } from "@/lib/queries/insights-games/battles";
import { getUpgraderProfitability } from "@/lib/queries/insights-games/upgrader";
import { getBorrowAnalytics } from "@/lib/queries/insights-games/borrow";
import {
  getGamesTopUsers,
  type GamesTopUsersFilters,
  type GamesLeaderboardRow,
} from "@/lib/queries/insights-games/top-users";
import { settle, unwrap, buildSection } from "../_export-section";

const AREA = "insights.export.games";

/**
 * Export gatherer for /insights/games.
 *
 * Bundles every tab's data for the active period into one CSV:
 * the Overview KPI rollup + time-series, per-pack profitability,
 * per-mode + top-battle profitability, upgrader buckets, borrow
 * cohorts + top borrowers, and the three top-users leaderboards.
 *
 * Every figure is borrow-corrected + creator-on-stream-excluded
 * because it reuses the exact same cached query helpers the page
 * renders — so the export reconciles with the UI. Read-only. Server-only;
 * auth is enforced by the route handler that calls this
 * (`/insights/export`), which gates on the same page-access key as the
 * page.
 *
 * The top-users tab honours its current filter set (game / minWager /
 * country) so the export matches what the admin is looking at.
 */
export async function gatherGamesExportSections(
  period: GamesPeriod,
  usersFilters: GamesTopUsersFilters,
): Promise<ExportSection[]> {
  // Settle (not await-throw) so one failed query degrades only its own
  // section(s) instead of crashing the gatherer → BOM-only download.
  // (The upgrader sub-query in particular throws on a DB missing the
  // upgrader enums/tables; isolating it keeps every other section.)
  const [overviewR, packsR, battlesR, upgraderR, borrowR, topUsersR] =
    await settle([
      getGamesOverview(period),
      getPacksProfitability(period),
      getBattlesProfitability(period),
      getUpgraderProfitability(period),
      getBorrowAnalytics(period),
      getGamesTopUsers(period, usersFilters),
    ]);
  const overview = () => unwrap(overviewR);
  const packs = () => unwrap(packsR);
  const battles = () => unwrap(battlesR);
  const upgrader = () => unwrap(upgraderR);
  const borrow = () => unwrap(borrowR);
  const topUsers = () => unwrap(topUsersR);

  const periodLabel = labelForPeriod(period);

  // Time-series header depends on the (possibly-failed) overview's
  // bucketByHour flag; default to daily when unavailable.
  const tsHourly =
    overviewR.status === "fulfilled" && overviewR.value.bucketByHour;

  const filterNote =
    `game=${usersFilters.game}, minWager=${usersFilters.minWager}` +
    (usersFilters.country ? `, country=${usersFilters.country}` : "");
  const leaderboardColumns = [
    "User ID",
    "Username",
    "Country",
    "Wager (USD)",
    "Payouts (USD)",
    "P&L (USD)",
    "Plays",
  ];
  const leaderboardRows = (rows: GamesLeaderboardRow[]) =>
    rows.map((r) => [
      r.userId,
      r.username,
      r.countryCode,
      r.wager,
      r.payouts,
      r.pnl,
      r.plays,
    ]);

  return [
    // ── Overview KPIs ─────────────────────────────────────────────
    buildSection(AREA, `Games Overview KPIs (${periodLabel})`, ["Metric", "Value"], () => {
      const k = overview().kpis;
      return [
        ["Period", periodLabel],
        ["Total wager (USD)", k.totalWager],
        ["Total payout (USD)", k.totalPayout],
        ["House P&L (USD)", k.housePnl],
        ["RTP %", k.rtpPct],
        ["House P&L margin %", k.housePnlMarginPct],
        ["Active users", k.activeUsers],
        ["Total plays", k.totalPlays],
        ["Pack P&L (USD)", k.packPnl],
        ["Battle P&L (USD)", k.battlePnl],
        ["Upgrader P&L (USD)", k.upgraderPnl],
        ["Pack wager (USD)", k.packWager],
        ["Battle wager (USD)", k.battleWager],
        ["Upgrader wager (USD)", k.upgraderWager],
        ["Pack payout (USD)", k.packPayout],
        ["Battle payout (USD)", k.battlePayout],
        ["Upgrader payout (USD)", k.upgraderPayout],
      ];
    }),

    // ── Overview time-series ──────────────────────────────────────
    buildSection(
      AREA,
      tsHourly ? "Games P&L Time Series (hourly)" : "Games P&L Time Series (daily)",
      ["Bucket", "Wager (USD)", "Payout (USD)", "P&L (USD)"],
      () => overview().series.map((p) => [p.bucket, p.wager, p.payout, p.pnl]),
    ),

    // ── Packs profitability ───────────────────────────────────────
    buildSection(
      AREA,
      "Pack Profitability",
      [
        "Pack ID",
        "Name",
        "Sticker price (USD)",
        "Opens",
        "Borrow-corrected wager (USD)",
        "Sticker wager (USD)",
        "Payouts (USD)",
        "P&L (USD)",
        "RTP %",
        "Margin %",
      ],
      () =>
        packs().packs.map((p) => [
          p.packId,
          p.name,
          p.stickerPrice,
          p.opens,
          p.borrowCorrectedWager,
          p.stickerWager,
          p.payouts,
          p.pnl,
          p.rtpPct,
          p.marginPct,
        ]),
    ),

    // ── Battles: totals + per-mode + top battles ──────────────────
    buildSection(AREA, "Battles Totals", ["Metric", "Value"], () => {
      const t = battles().totals;
      return [
        ["Battles", t.battles],
        ["Wager (USD)", t.wager],
        ["Payouts (USD)", t.payouts],
        ["P&L (USD)", t.pnl],
        ["Margin %", t.marginPct],
        ["Avg bet (USD)", t.avgBetUsd],
      ];
    }),
    buildSection(
      AREA,
      "Battles by Mode",
      ["Mode", "Battles", "Avg pot (USD)", "Wager (USD)", "Payout (USD)", "P&L (USD)", "Margin %"],
      () =>
        battles().byMode.map((m) => [
          m.mode,
          m.battles,
          m.avgPotUsd,
          m.totalWager,
          m.totalPayout,
          m.pnl,
          m.marginPct,
        ]),
    ),
    buildSection(
      AREA,
      "Top Battles",
      [
        "Battle ID",
        "Mode",
        "Players",
        "Bet (USD)",
        "Total pot (USD)",
        "Total payout (USD)",
        "House P&L (USD)",
        "Hit multiplier",
        "Created (UTC)",
      ],
      () =>
        battles().topBattles.map((b) => [
          b.battleId,
          b.mode,
          b.playersTotal,
          b.betAmount,
          b.totalPot,
          b.totalPayout,
          b.housePnl,
          b.hitMultiplier,
          b.createdAt,
        ]),
    ),

    // ── Upgrader: totals + buckets ────────────────────────────────
    buildSection(AREA, "Upgrader Totals", ["Metric", "Value"], () => {
      const t = upgrader().totals;
      return [
        ["Bets", t.bets],
        ["Wins", t.wins],
        ["Losses", t.losses],
        ["Hit rate %", t.hitRatePct],
        ["Wager (USD)", t.wager],
        ["Payouts (USD)", t.payouts],
        ["P&L (USD)", t.pnl],
        ["Margin %", t.marginPct],
        ["RTP %", t.rtpPct],
        ["Avg bet (USD)", t.avgBet],
      ];
    }),
    buildSection(
      AREA,
      "Upgrader by Multiplier Bucket",
      ["Bucket", "Bets", "Wager (USD)", "Payout (USD)", "P&L (USD)", "Margin %", "Hit rate %", "RTP %"],
      () =>
        upgrader().buckets.map((b) => [
          b.label,
          b.bets,
          b.totalWager,
          b.totalPayout,
          b.pnl,
          b.marginPct,
          b.hitRatePct,
          b.rtpPct,
        ]),
    ),

    // ── Borrow: totals + cohorts + top borrowers + biggest play ───
    buildSection(AREA, "Borrow Totals", ["Metric", "Value"], () => {
      const t = borrow().totals;
      return [
        ["Borrowed plays", t.borrowedPlaysCount],
        ["Cash paid sum (USD)", t.cashPaidSum],
        ["Borrowed amount sum (USD)", t.borrowedAmountSum],
        ["Sticker sum (USD)", t.stickerSum],
        ["Borrow share %", t.borrowSharePct],
        ["Total plays (incl. non-borrow)", t.totalPlaysIncludingNonBorrow],
        ["Borrow share of plays %", t.borrowShareOfPlaysPct],
      ];
    }),
    buildSection(
      AREA,
      "Borrow Cohorts",
      [
        "Cohort",
        "Users",
        "Total wager (USD)",
        "Total payout (USD)",
        "Avg wager/user (USD)",
        "Avg payout/user (USD)",
        "Avg P&L/user (USD)",
        "RTP %",
      ],
      () =>
        borrow().cohorts.map((c) => [
          c.label,
          c.users,
          c.totalWager,
          c.totalPayout,
          c.avgWagerPerUser,
          c.avgPayoutPerUser,
          c.avgPnlPerUser,
          c.rtpPct,
        ]),
    ),
    buildSection(
      AREA,
      "Top Borrowers",
      [
        "User ID",
        "Username",
        "Borrowed amount (USD)",
        "Cash paid (USD)",
        "Borrow plays",
        "Avg borrow %",
        "Total wager on page (USD)",
        "Borrow share of wager %",
      ],
      () =>
        borrow().topUsers.map((u) => [
          u.userId,
          u.username,
          u.borrowedAmountSum,
          u.cashPaidSum,
          u.borrowPlays,
          u.avgBorrowPct,
          u.totalWagerOnPage,
          u.borrowShareOfWagerPct,
        ]),
    ),
    // Biggest borrow play — always emit the section; rows are empty when
    // the query failed OR when there is genuinely no biggest play.
    buildSection(AREA, "Biggest Borrow Play", ["Metric", "Value"], () => {
      const b = borrow().biggestPlay;
      if (!b) return [];
      return [
        ["Ledger TX ID", b.ledgerTxId],
        ["User ID", b.userId],
        ["Username", b.username],
        ["Type", b.type],
        ["Cash paid (USD)", b.cashPaid],
        ["Borrowed amount (USD)", b.borrowedAmount],
        ["Sticker exposure (USD)", b.stickerExposure],
        ["Borrow %", b.borrowPct],
        ["Created (UTC)", b.createdAt],
      ];
    }),

    // ── Top users leaderboards (filtered to current view) ─────────
    buildSection(
      AREA,
      `Top Wagerers (${filterNote})`,
      leaderboardColumns,
      () => leaderboardRows(topUsers().topWagerers),
    ),
    buildSection(
      AREA,
      `Top Winners (${filterNote})`,
      leaderboardColumns,
      () => leaderboardRows(topUsers().topWinners),
    ),
    buildSection(
      AREA,
      `Top Losers (${filterNote})`,
      leaderboardColumns,
      () => leaderboardRows(topUsers().topLosers),
    ),
  ];
}
