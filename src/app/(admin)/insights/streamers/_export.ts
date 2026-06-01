import "server-only";

import type { ExportSection } from "@/lib/utils/export-csv";
import { periodLabel, type StreamerPeriod } from "./types";
import { getStreamerInsightRows } from "@/lib/queries/insights-streamers/overview";
import { getCreatorRiskRows } from "@/lib/queries/insights-streamers/abuse";
import { getCodeSwitchers } from "@/lib/queries/insights-streamers/code-switching";
import { getLeaderboardSnipers } from "@/lib/queries/insights-streamers/leaderboard-sniping";

/**
 * Export gatherer for /insights/streamers.
 *
 * Bundles every tab's data for the active period into one CSV:
 * the per-creator insight rows (Overview / Money Makers / ROI all share
 * this dataset), the risk-scored creators (Sus / Abuse) with their
 * signal breakdown flattened, code-switchers with their code chronology,
 * and leaderboard snipers.
 *
 * Reuses the exact same cached query helpers the page renders, so the
 * export reconciles with the UI by construction. House-POV numerics
 * throughout (positive housePnl = house kept money). Read-only.
 * Server-only; auth is enforced by the route handler that calls this
 * (`/insights/export`), which gates on the same page-access key as the
 * page.
 */
export async function gatherStreamersExportSections(
  period: StreamerPeriod,
): Promise<ExportSection[]> {
  const [creators, risk, switchers, snipers] = await Promise.all([
    getStreamerInsightRows(period),
    getCreatorRiskRows(period),
    getCodeSwitchers(period),
    getLeaderboardSnipers(period),
  ]);

  const label = periodLabel(period);
  const sections: ExportSection[] = [];

  // ── Per-creator insight rows (Overview / Money Makers / ROI) ────
  sections.push({
    name: `Creator Insights (${label})`,
    columns: [
      "User ID",
      "Username",
      "Email",
      "Primary code",
      "Referred count",
      "Active referred",
      "FTD referred",
      "Cohort wager (USD)",
      "Cohort deposits (USD)",
      "Cohort card withdrawals (USD)",
      "Commission accrued (USD)",
      "Payout settled (USD)",
      "House P&L (USD)",
      "House ROI",
    ],
    rows: creators.map((c) => [
      c.userId,
      c.username,
      c.email,
      c.primaryCode,
      c.referredCount,
      c.activeReferredCount,
      c.ftdReferredCount,
      c.cohortWagerUsd,
      c.cohortDepositsUsd,
      c.cohortCardWithdrawalsUsd,
      c.commissionAccruedUsd,
      c.payoutSettledUsd,
      c.housePnl,
      c.houseRoi,
    ]),
  });

  // ── Risk-scored creators + signal breakdown ─────────────────────
  sections.push({
    name: "Creator Risk Scores",
    columns: [
      "User ID",
      "Username",
      "Primary code",
      "Total risk score",
      "Referred count",
      "Cohort wager (USD)",
      "Signals",
    ],
    rows: risk.map((r) => [
      r.userId,
      r.username,
      r.primaryCode,
      r.totalRiskScore,
      r.referredCount,
      r.cohortWagerUsd,
      r.signals
        .map((s) =>
          s.detail ? `${s.label} (${s.score}: ${s.detail})` : `${s.label} (${s.score})`,
        )
        .join(" | "),
    ]),
  });

  // ── Code switchers + chronology ─────────────────────────────────
  sections.push({
    name: "Code Switchers",
    columns: [
      "User ID",
      "Username",
      "Email",
      "Code count",
      "Code chronology (oldest→newest)",
      "Total wager (USD)",
      "Total deposits (USD)",
      "Race claims",
      "Race claim (USD)",
    ],
    rows: switchers.map((s) => [
      s.userId,
      s.username,
      s.email,
      s.codeCount,
      s.codeChronology
        .map((c) => `${c.code}@${c.firstUsedAt}${c.ownerUsername ? ` (${c.ownerUsername})` : ""}`)
        .join(" | "),
      s.totalWagerUsd,
      s.totalDepositsUsd,
      s.raceClaimCount,
      s.raceClaimUsd,
    ]),
  });

  // ── Leaderboard snipers ─────────────────────────────────────────
  sections.push({
    name: "Leaderboard Snipers",
    columns: [
      "User ID",
      "Username",
      "Race type",
      "Race period start",
      "Position",
      "Prize (USD)",
      "Code at claim",
      "Total codes used",
      "Most recent code",
      "Switched away",
    ],
    rows: snipers.map((s) => [
      s.userId,
      s.username,
      s.raceType,
      s.racePeriodStart,
      s.position,
      s.prizeUsd,
      s.codeAtClaim,
      s.totalCodesUsed,
      s.mostRecentCode,
      s.switchedAway ? "yes" : "no",
    ]),
  });

  return sections;
}
