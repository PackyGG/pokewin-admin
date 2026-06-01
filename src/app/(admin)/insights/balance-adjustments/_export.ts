"use server";

import { requirePageAccess } from "@/lib/dal";
import type { ExportSection } from "@/lib/utils/export-csv";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getBalanceAdjustmentOverview } from "@/lib/queries/insights-balance-adjustments/overview";
import { getBalanceAdjustmentDirectionReason } from "@/lib/queries/insights-balance-adjustments/direction-reason";
import { getBalanceAdjustmentByAdmin } from "@/lib/queries/insights-balance-adjustments/by-admin";
import { getBalanceAdjustmentByUser } from "@/lib/queries/insights-balance-adjustments/by-user";
import { getBalanceAdjustmentAuditTrail } from "@/lib/queries/insights-balance-adjustments/audit-trail";

/**
 * Audit-trail export depth — the page shows 200; the export pulls a
 * fuller slice (bounded) so the CSV captures more of the forensic trail
 * than the on-screen table.
 */
const AUDIT_EXPORT_LIMIT = 1000;

/**
 * Server export action for /insights/balance-adjustments.
 *
 * Bundles every tab's data for the active period into one CSV: overview
 * KPIs + daily credit/debit series, direction & reason breakdown + size
 * buckets, per-admin accountability, top-credited / top-debited /
 * high-frequency users, and the audit trail (admin → user, deeper than
 * the UI's 200-row view).
 *
 * Reuses the exact same cached query helpers the page renders. House-POV
 * (CLAUDE.md): a credit to a user is house cost; CSV carries signed raw
 * machine values. Admin attribution comes from the admin-DB audit trail
 * (never SQL-joined to the main DB). Read-only. Gated by the same
 * page-access check as the page.
 */
export async function exportBalanceAdjustmentsData(
  period: InsightsRewardsPeriod,
): Promise<ExportSection[]> {
  await requirePageAccess("/insights/balance-adjustments");

  const [overview, direction, byAdmin, byUser, audit] = await Promise.all([
    getBalanceAdjustmentOverview(period),
    getBalanceAdjustmentDirectionReason(period),
    getBalanceAdjustmentByAdmin(period),
    getBalanceAdjustmentByUser(period),
    getBalanceAdjustmentAuditTrail(period, AUDIT_EXPORT_LIMIT),
  ]);

  const label = insightsRewardsPeriodLabel(period);
  const prior = overview.priorWindow;
  const sections: ExportSection[] = [];

  // ── Overview KPIs ───────────────────────────────────────────────
  sections.push({
    name: `Balance Adjustments Overview KPIs (${label})`,
    columns: ["Metric", "Value"],
    rows: [
      ["Period", label],
      ["Credit volume (USD)", overview.creditVolume],
      ["Credit count", overview.creditCount],
      ["Debit volume (USD)", overview.debitVolume],
      ["Debit count", overview.debitCount],
      ["Gross volume (USD)", overview.grossVolume],
      ["Net user gain (USD)", overview.netUserGain],
      ["Total count", overview.count],
      ["Unique users", overview.uniqueUsers],
      ["Unique admins", overview.uniqueAdmins],
      ["Avg size (USD)", overview.avgSize],
      ["Median size (USD)", overview.medianSize],
      ["Max size (USD)", overview.maxSize],
      ["Prior gross volume (USD)", prior?.grossVolume ?? null],
      ["Prior net user gain (USD)", prior?.netUserGain ?? null],
      ["Prior count", prior?.count ?? null],
      ["Prior unique users", prior?.uniqueUsers ?? null],
      ["Gross delta vs prior", prior?.grossDelta ?? null],
      ["Count delta vs prior", prior?.countDelta ?? null],
      ["User delta vs prior", prior?.userDelta ?? null],
    ],
  });

  // ── Daily series ────────────────────────────────────────────────
  sections.push({
    name: "Balance Adjustments Daily Series",
    columns: ["Date", "Credit volume (USD)", "Debit volume (USD)", "Count"],
    rows: overview.daily.map((d) => [
      d.date,
      d.creditVolume,
      d.debitVolume,
      d.count,
    ]),
  });

  // ── Direction & reason ──────────────────────────────────────────
  sections.push({
    name: "Direction Summary",
    columns: ["Metric", "Value"],
    rows: [
      ["Credit volume (USD)", direction.creditVolume],
      ["Credit count", direction.creditCount],
      ["Debit volume (USD)", direction.debitVolume],
      ["Debit count", direction.debitCount],
    ],
  });
  sections.push({
    name: "Adjustment Reasons",
    columns: [
      "Reason",
      "Is manual withdrawal",
      "Credit volume (USD)",
      "Debit volume (USD)",
      "Net (USD)",
      "Count",
      "Unique users",
    ],
    rows: direction.reasons.map((r) => [
      r.reason,
      r.isManualWithdrawal ? "yes" : "no",
      r.creditVolume,
      r.debitVolume,
      r.net,
      r.count,
      r.uniqueUsers,
    ]),
  });
  sections.push({
    name: "Adjustment Size Distribution",
    columns: ["Bucket", "Min (USD)", "Max (USD)", "Count", "Volume (USD)"],
    rows: direction.sizeBuckets.map((b) => [
      b.label,
      b.min,
      b.max,
      b.count,
      b.volume,
    ]),
  });

  // ── By admin ────────────────────────────────────────────────────
  sections.push({
    name: "Adjustments by Admin",
    columns: [
      "Admin user ID",
      "Username",
      "Display username",
      "Net (USD)",
      "Credit volume (USD)",
      "Debit volume (USD)",
      "Gross volume (USD)",
      "Count",
      "Unique users",
      "Avg size (USD)",
      "Max size (USD)",
    ],
    rows: byAdmin.map((a) => [
      a.adminUserId,
      a.username,
      a.displayUsername,
      a.net,
      a.creditVolume,
      a.debitVolume,
      a.grossVolume,
      a.count,
      a.uniqueUsers,
      a.avgSize,
      a.maxSize,
    ]),
  });

  // ── By user (3 lists) ───────────────────────────────────────────
  const userColumns = [
    "User ID",
    "Username",
    "Credit volume (USD)",
    "Debit volume (USD)",
    "Net (USD)",
    "Count",
    "Last at (UTC)",
  ];
  const userRows = (rows: typeof byUser.topCredited) =>
    rows.map((u) => [
      u.userId,
      u.username,
      u.creditVolume,
      u.debitVolume,
      u.net,
      u.count,
      u.lastAt,
    ]);
  sections.push({
    name: "Top Credited Users",
    columns: userColumns,
    rows: userRows(byUser.topCredited),
  });
  sections.push({
    name: "Top Debited Users",
    columns: userColumns,
    rows: userRows(byUser.topDebited),
  });
  sections.push({
    name: "High-Frequency Adjustment Users",
    columns: userColumns,
    rows: userRows(byUser.highFrequency),
  });

  // ── Audit trail (deeper than UI) ────────────────────────────────
  sections.push({
    name: `Audit Trail (up to ${AUDIT_EXPORT_LIMIT} rows; ${audit.totalInWindow} in window, ${audit.attributedCount} attributed)`,
    columns: [
      "Ledger TX ID",
      "Created at (UTC)",
      "Amount (USD, signed)",
      "Direction",
      "Is manual withdrawal",
      "Reason",
      "User ID",
      "Username",
      "Admin user ID",
      "Admin username",
      "Attribution exact",
    ],
    rows: audit.rows.map((r) => [
      r.ledgerTxId,
      r.createdAt,
      r.amount,
      r.direction,
      r.isManualWithdrawal ? "yes" : "no",
      r.reason,
      r.user.userId,
      r.user.username,
      r.admin?.adminUserId ?? null,
      r.admin?.username ?? null,
      r.attributionExact ? "yes" : "no",
    ]),
  });

  return sections;
}
