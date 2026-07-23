import "server-only";

import type { ExportSection } from "@/lib/utils/export-csv";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getRewardsCrossCategorySummary } from "@/lib/queries/insights-rewards/cross-category-summary";
import { getRewardProgramSpend } from "@/lib/queries/insights-rewards/program-spend";
import { getRewardProgramRecipients } from "@/lib/queries/insights-rewards/program-recipients";
import { getCreatorWithdrawalsSummary } from "@/lib/queries/insights-rewards/creator-withdrawals";
import { getDailyPacksGiveaway } from "@/lib/queries/insights-rewards/daily-packs";
import { settle, unwrap, buildSection } from "../_export-section";

const AREA = "insights.export.rewards";

/**
 * Export gatherer for the Analytics → Rewards tab.
 *
 * Mirrors what the page renders (owner, 2026-07-23): spend keyed on the seven
 * PROGRAMS, not the old ledger-family categories. Exporting one shape while
 * the screen shows another is how a spreadsheet ends up contradicting the
 * dashboard it was pulled from, so the two move together.
 *
 * Bundles: the KPI summary (spend vs GGR vs wager), per-program spend, the
 * itemised residual, the per-program daily series, the top recipients, and
 * the daily-pack per-pack detail.
 *
 * Reuses the same cached query helpers the views render — no extra scans.
 * Read-only. Server-only; auth is enforced by the route handler that calls
 * this (`/insights/export`), which gates on the same page-access key.
 */
export async function gatherRewardsOverviewExportSections(
  period: InsightsRewardsPeriod,
): Promise<ExportSection[]> {
  // Settle (not await-throw) so one failed query degrades only its own
  // section(s) instead of crashing the gatherer → BOM-only download.
  const [summaryR, spendR, creatorWdR, dailyPacksR, recipientsR] = await settle([
    getRewardsCrossCategorySummary(period),
    getRewardProgramSpend(period),
    getCreatorWithdrawalsSummary(period),
    getDailyPacksGiveaway(period),
    getRewardProgramRecipients(period),
  ]);
  const summary = () => unwrap(summaryR);
  const spend = () => unwrap(spendR);
  const creatorWd = () => unwrap(creatorWdR);
  const dailyPacks = () => unwrap(dailyPacksR);
  const recipients = () => unwrap(recipientsR);

  const periodLabel = insightsRewardsPeriodLabel(period);

  return [
    // ── Cross-category KPI summary ────────────────────────────────
    buildSection(AREA, `Rewards Overview KPIs (${periodLabel})`, ["Metric", "Value"], () => {
      const s = summary();
      const prior = s.priorWindow;
      // Creator-withdrawals is its own query; if only that one failed,
      // still emit the rest with em-dash placeholders for its two cells.
      let cwTotal: number | null = null;
      let cwCount: number | null = null;
      try {
        const cw = creatorWd();
        cwTotal = cw.total;
        cwCount = cw.count;
      } catch {
        /* leave nulls — its own section logs the failure */
      }
      return [
        ["Period", periodLabel],
        ["Total marketing cost (USD)", s.totalCost],
        ["Total payouts (count)", s.totalCount],
        ["Active claimants", s.activeClaimants],
        ["Total wager (USD)", s.totalWager],
        ["Total reward payouts (USD)", s.totalPayouts],
        ["GGR (USD)", s.ggr],
        ["Marketing % of GGR", s.marketingPctOfGgr],
        ["Marketing % of wager", s.marketingPctOfWager],
        ["Creator withdrawals total (USD)", cwTotal],
        ["Creator withdrawals count", cwCount],
        ["Prior cost (USD)", prior?.totalCost ?? null],
        ["Prior payout count", prior?.totalCount ?? null],
        ["Prior claimants", prior?.activeClaimants ?? null],
        ["Cost delta vs prior", prior?.costDelta ?? null],
        ["Count delta vs prior", prior?.countDelta ?? null],
        ["Claimant delta vs prior", prior?.claimantDelta ?? null],
      ];
    }),

    // ── Spend by program ──────────────────────────────────────────
    buildSection(
      AREA,
      "Spend by Program",
      [
        "Program",
        "Total (USD)",
        "Payouts",
        "Players reached",
        "Share %",
        "Avg per player (USD)",
        "Avg per payout (USD)",
      ],
      () =>
        spend().rows.map((r) => [
          r.label,
          r.total,
          r.count,
          r.claimants,
          r.share,
          r.avgPerClaimant,
          r.avgPerPayout,
        ]),
    ),

    // ── The itemised residual ─────────────────────────────────────
    // "Other house credits" is a bucket, so the CSV spells out what landed
    // in it — same reason the page itemises it on screen.
    buildSection(
      AREA,
      "Other House Credits — Breakdown",
      ["Program", "Source", "Total (USD)", "Payouts"],
      () =>
        spend()
          .rows.filter((r) => r.components.length > 0)
          .flatMap((r) =>
            r.components.map((c) => [r.label, c.label, c.total, c.count]),
          ),
    ),

    // ── Per-program daily time-series (long format) ───────────────
    buildSection(
      AREA,
      "Daily Cost by Program",
      ["Date", "Program", "Total (USD)"],
      () => {
        const dailyRows: (string | number)[][] = [];
        for (const row of spend().rows) {
          for (const pt of row.dailySeries) {
            dailyRows.push([pt.date, row.label, pt.total]);
          }
        }
        dailyRows.sort(
          (a, b) =>
            String(a[0]).localeCompare(String(b[0])) ||
            String(a[1]).localeCompare(String(b[1])),
        );
        return dailyRows;
      },
    ),

    // ── Top reward recipients ─────────────────────────────────────
    // Ledger programs only — daily packs and the creator pool are excluded
    // from the ranking (see program-recipients.ts), so the header says so
    // rather than letting a reader assume the total is every program.
    buildSection(
      AREA,
      "Top Reward Recipients (ledger programs only)",
      [
        "Rank",
        "User ID",
        "Username",
        "Reward paid (USD)",
        "Programs used",
        "Deposit bonus (USD)",
        "Rakeback (USD)",
        "Lossback (USD)",
        "Leaderboards (USD)",
        "Races (USD)",
        "Other (USD)",
        "Their GGR (USD)",
        "Net to house (USD)",
      ],
      () =>
        recipients().map((r, i) => [
          i + 1,
          r.userId,
          r.username ?? "",
          r.total,
          r.programCount,
          r.perProgram.depositBonus,
          r.perProgram.rakeback,
          r.perProgram.lossback,
          r.perProgram.leaderboards,
          r.perProgram.races,
          r.perProgram.other,
          r.ggrInWindow,
          r.netToHouse,
        ]),
    ),

    // ── Daily / free pack giveaway — KPIs ─────────────────────────
    buildSection(
      AREA,
      `Daily / Free Pack Giveaway (${periodLabel})`,
      ["Metric", "Value"],
      () => {
        const d = dailyPacks();
        return [
          ["Period", periodLabel],
          ["Giveaway cost — cards given away (USD)", d.giveawayPayout],
          ["Wager collected on opens (USD)", d.wager],
          ["Net cost after wager (USD)", d.netCost],
          ["Daily packs opened", d.opens],
          ["Distinct claimers", d.claimers],
          ["Cards handed out", d.cards],
          ["Avg cost per pack (USD)", d.avgCostPerPack],
        ];
      },
    ),

    // ── Daily / free pack giveaway — per pack ─────────────────────
    buildSection(
      AREA,
      "Daily / Free Pack Giveaway by Pack",
      ["Pack", "Opens", "Claimers", "Giveaway cost (USD)", "Wager (USD)", "Net cost (USD)"],
      () =>
        dailyPacks().packs.map((p) => [
          p.name,
          p.opens,
          p.claimers,
          p.giveawayPayout,
          p.wager,
          p.netCost,
        ]),
    ),
  ];
}
