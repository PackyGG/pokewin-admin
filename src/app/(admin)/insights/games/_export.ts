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
  const [overview, packs, battles, upgrader, borrow, topUsers] =
    await Promise.all([
      getGamesOverview(period),
      getPacksProfitability(period),
      getBattlesProfitability(period),
      getUpgraderProfitability(period),
      getBorrowAnalytics(period),
      getGamesTopUsers(period, usersFilters),
    ]);

  const periodLabel = labelForPeriod(period);
  const k = overview.kpis;
  const sections: ExportSection[] = [];

  // ── Overview KPIs ───────────────────────────────────────────────
  sections.push({
    name: `Games Overview KPIs (${periodLabel})`,
    columns: ["Metric", "Value"],
    rows: [
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
    ],
  });

  // ── Overview time-series ────────────────────────────────────────
  sections.push({
    name: overview.bucketByHour
      ? "Games P&L Time Series (hourly)"
      : "Games P&L Time Series (daily)",
    columns: ["Bucket", "Wager (USD)", "Payout (USD)", "P&L (USD)"],
    rows: overview.series.map((p) => [p.bucket, p.wager, p.payout, p.pnl]),
  });

  // ── Packs profitability ─────────────────────────────────────────
  sections.push({
    name: "Pack Profitability",
    columns: [
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
    rows: packs.packs.map((p) => [
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
  });

  // ── Battles: totals + per-mode + top battles ────────────────────
  sections.push({
    name: "Battles Totals",
    columns: ["Metric", "Value"],
    rows: [
      ["Battles", battles.totals.battles],
      ["Wager (USD)", battles.totals.wager],
      ["Payouts (USD)", battles.totals.payouts],
      ["P&L (USD)", battles.totals.pnl],
      ["Margin %", battles.totals.marginPct],
      ["Avg bet (USD)", battles.totals.avgBetUsd],
    ],
  });
  sections.push({
    name: "Battles by Mode",
    columns: [
      "Mode",
      "Battles",
      "Avg pot (USD)",
      "Wager (USD)",
      "Payout (USD)",
      "P&L (USD)",
      "Margin %",
    ],
    rows: battles.byMode.map((m) => [
      m.mode,
      m.battles,
      m.avgPotUsd,
      m.totalWager,
      m.totalPayout,
      m.pnl,
      m.marginPct,
    ]),
  });
  sections.push({
    name: "Top Battles",
    columns: [
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
    rows: battles.topBattles.map((b) => [
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
  });

  // ── Upgrader: totals + buckets ──────────────────────────────────
  sections.push({
    name: "Upgrader Totals",
    columns: ["Metric", "Value"],
    rows: [
      ["Bets", upgrader.totals.bets],
      ["Wins", upgrader.totals.wins],
      ["Losses", upgrader.totals.losses],
      ["Hit rate %", upgrader.totals.hitRatePct],
      ["Wager (USD)", upgrader.totals.wager],
      ["Payouts (USD)", upgrader.totals.payouts],
      ["P&L (USD)", upgrader.totals.pnl],
      ["Margin %", upgrader.totals.marginPct],
      ["RTP %", upgrader.totals.rtpPct],
      ["Avg bet (USD)", upgrader.totals.avgBet],
    ],
  });
  sections.push({
    name: "Upgrader by Multiplier Bucket",
    columns: [
      "Bucket",
      "Bets",
      "Wager (USD)",
      "Payout (USD)",
      "P&L (USD)",
      "Margin %",
      "Hit rate %",
      "RTP %",
    ],
    rows: upgrader.buckets.map((b) => [
      b.label,
      b.bets,
      b.totalWager,
      b.totalPayout,
      b.pnl,
      b.marginPct,
      b.hitRatePct,
      b.rtpPct,
    ]),
  });

  // ── Borrow: totals + cohorts + top borrowers + biggest play ─────
  sections.push({
    name: "Borrow Totals",
    columns: ["Metric", "Value"],
    rows: [
      ["Borrowed plays", borrow.totals.borrowedPlaysCount],
      ["Cash paid sum (USD)", borrow.totals.cashPaidSum],
      ["Borrowed amount sum (USD)", borrow.totals.borrowedAmountSum],
      ["Sticker sum (USD)", borrow.totals.stickerSum],
      ["Borrow share %", borrow.totals.borrowSharePct],
      ["Total plays (incl. non-borrow)", borrow.totals.totalPlaysIncludingNonBorrow],
      ["Borrow share of plays %", borrow.totals.borrowShareOfPlaysPct],
    ],
  });
  sections.push({
    name: "Borrow Cohorts",
    columns: [
      "Cohort",
      "Users",
      "Total wager (USD)",
      "Total payout (USD)",
      "Avg wager/user (USD)",
      "Avg payout/user (USD)",
      "Avg P&L/user (USD)",
      "RTP %",
    ],
    rows: borrow.cohorts.map((c) => [
      c.label,
      c.users,
      c.totalWager,
      c.totalPayout,
      c.avgWagerPerUser,
      c.avgPayoutPerUser,
      c.avgPnlPerUser,
      c.rtpPct,
    ]),
  });
  sections.push({
    name: "Top Borrowers",
    columns: [
      "User ID",
      "Username",
      "Borrowed amount (USD)",
      "Cash paid (USD)",
      "Borrow plays",
      "Avg borrow %",
      "Total wager on page (USD)",
      "Borrow share of wager %",
    ],
    rows: borrow.topUsers.map((u) => [
      u.userId,
      u.username,
      u.borrowedAmountSum,
      u.cashPaidSum,
      u.borrowPlays,
      u.avgBorrowPct,
      u.totalWagerOnPage,
      u.borrowShareOfWagerPct,
    ]),
  });
  if (borrow.biggestPlay) {
    const b = borrow.biggestPlay;
    sections.push({
      name: "Biggest Borrow Play",
      columns: ["Metric", "Value"],
      rows: [
        ["Ledger TX ID", b.ledgerTxId],
        ["User ID", b.userId],
        ["Username", b.username],
        ["Type", b.type],
        ["Cash paid (USD)", b.cashPaid],
        ["Borrowed amount (USD)", b.borrowedAmount],
        ["Sticker exposure (USD)", b.stickerExposure],
        ["Borrow %", b.borrowPct],
        ["Created (UTC)", b.createdAt],
      ],
    });
  }

  // ── Top users leaderboards (filtered to current view) ───────────
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
  sections.push({
    name: `Top Wagerers (${filterNote})`,
    columns: leaderboardColumns,
    rows: leaderboardRows(topUsers.topWagerers),
  });
  sections.push({
    name: `Top Winners (${filterNote})`,
    columns: leaderboardColumns,
    rows: leaderboardRows(topUsers.topWinners),
  });
  sections.push({
    name: `Top Losers (${filterNote})`,
    columns: leaderboardColumns,
    rows: leaderboardRows(topUsers.topLosers),
  });

  return sections;
}
