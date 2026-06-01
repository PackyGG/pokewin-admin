import "server-only";

import type { ExportSection } from "@/lib/utils/export-csv";
import {
  insightsRewardsPeriodLabel,
  type InsightsRewardsPeriod,
} from "@/lib/queries/insights-rewards/_period";
import { getBalanceAdjustmentOverview } from "@/lib/queries/insights-balance-adjustments/overview";
import { getBalanceAdjustmentDirectionReason } from "@/lib/queries/insights-balance-adjustments/direction-reason";
import { getBalanceAdjustmentByAdmin } from "@/lib/queries/insights-balance-adjustments/by-admin";
import {
  getBalanceAdjustmentByUser,
  type UserAdjustmentRow,
} from "@/lib/queries/insights-balance-adjustments/by-user";
import { getBalanceAdjustmentAuditTrail } from "@/lib/queries/insights-balance-adjustments/audit-trail";
import { settle, unwrap, buildSection } from "../_export-section";

const AREA = "insights.export.balance-adjustments";

/**
 * Audit-trail export depth — the page shows 200; the export pulls a
 * fuller slice (bounded) so the CSV captures more of the forensic trail
 * than the on-screen table.
 */
const AUDIT_EXPORT_LIMIT = 1000;

/**
 * Export gatherer for /insights/balance-adjustments.
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
 * (never SQL-joined to the main DB). Read-only. Server-only; auth is
 * enforced by the route handler that calls this (`/insights/export`),
 * which gates on the same page-access key as the page.
 */
export async function gatherBalanceAdjustmentsExportSections(
  period: InsightsRewardsPeriod,
): Promise<ExportSection[]> {
  // Settle (not await-throw) so one failed query degrades only its own
  // section(s) instead of crashing the gatherer → BOM-only download.
  const [overviewR, directionR, byAdminR, byUserR, auditR] = await settle([
    getBalanceAdjustmentOverview(period),
    getBalanceAdjustmentDirectionReason(period),
    getBalanceAdjustmentByAdmin(period),
    getBalanceAdjustmentByUser(period),
    getBalanceAdjustmentAuditTrail(period, AUDIT_EXPORT_LIMIT),
  ]);
  const overview = () => unwrap(overviewR);
  const direction = () => unwrap(directionR);
  const byAdmin = () => unwrap(byAdminR);
  const byUser = () => unwrap(byUserR);
  const audit = () => unwrap(auditR);

  const label = insightsRewardsPeriodLabel(period);

  const userColumns = [
    "User ID",
    "Username",
    "Credit volume (USD)",
    "Debit volume (USD)",
    "Net (USD)",
    "Count",
    "Last at (UTC)",
  ];
  const userRows = (rows: UserAdjustmentRow[]) =>
    rows.map((u) => [
      u.userId,
      u.username,
      u.creditVolume,
      u.debitVolume,
      u.net,
      u.count,
      u.lastAt,
    ]);

  // Audit-trail section name embeds counts from the (possibly-failed)
  // audit query; fall back to a plain name when it's unavailable.
  const auditName =
    auditR.status === "fulfilled"
      ? `Audit Trail (up to ${AUDIT_EXPORT_LIMIT} rows; ${auditR.value.totalInWindow} in window, ${auditR.value.attributedCount} attributed)`
      : `Audit Trail (up to ${AUDIT_EXPORT_LIMIT} rows)`;

  return [
    // ── Overview KPIs ─────────────────────────────────────────────
    buildSection(AREA, `Balance Adjustments Overview KPIs (${label})`, ["Metric", "Value"], () => {
      const o = overview();
      const prior = o.priorWindow;
      return [
        ["Period", label],
        ["Credit volume (USD)", o.creditVolume],
        ["Credit count", o.creditCount],
        ["Debit volume (USD)", o.debitVolume],
        ["Debit count", o.debitCount],
        ["Gross volume (USD)", o.grossVolume],
        ["Net user gain (USD)", o.netUserGain],
        ["Total count", o.count],
        ["Unique users", o.uniqueUsers],
        ["Unique admins", o.uniqueAdmins],
        ["Avg size (USD)", o.avgSize],
        ["Median size (USD)", o.medianSize],
        ["Max size (USD)", o.maxSize],
        ["Prior gross volume (USD)", prior?.grossVolume ?? null],
        ["Prior net user gain (USD)", prior?.netUserGain ?? null],
        ["Prior count", prior?.count ?? null],
        ["Prior unique users", prior?.uniqueUsers ?? null],
        ["Gross delta vs prior", prior?.grossDelta ?? null],
        ["Count delta vs prior", prior?.countDelta ?? null],
        ["User delta vs prior", prior?.userDelta ?? null],
      ];
    }),

    // ── Daily series ──────────────────────────────────────────────
    buildSection(
      AREA,
      "Balance Adjustments Daily Series",
      ["Date", "Credit volume (USD)", "Debit volume (USD)", "Count"],
      () => overview().daily.map((d) => [d.date, d.creditVolume, d.debitVolume, d.count]),
    ),

    // ── Direction & reason ────────────────────────────────────────
    buildSection(AREA, "Direction Summary", ["Metric", "Value"], () => {
      const d = direction();
      return [
        ["Credit volume (USD)", d.creditVolume],
        ["Credit count", d.creditCount],
        ["Debit volume (USD)", d.debitVolume],
        ["Debit count", d.debitCount],
      ];
    }),
    buildSection(
      AREA,
      "Adjustment Reasons",
      [
        "Reason",
        "Is manual withdrawal",
        "Credit volume (USD)",
        "Debit volume (USD)",
        "Net (USD)",
        "Count",
        "Unique users",
      ],
      () =>
        direction().reasons.map((r) => [
          r.reason,
          r.isManualWithdrawal ? "yes" : "no",
          r.creditVolume,
          r.debitVolume,
          r.net,
          r.count,
          r.uniqueUsers,
        ]),
    ),
    buildSection(
      AREA,
      "Adjustment Size Distribution",
      ["Bucket", "Min (USD)", "Max (USD)", "Count", "Volume (USD)"],
      () => direction().sizeBuckets.map((b) => [b.label, b.min, b.max, b.count, b.volume]),
    ),

    // ── By admin ──────────────────────────────────────────────────
    buildSection(
      AREA,
      "Adjustments by Admin",
      [
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
      () =>
        byAdmin().map((a) => [
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
    ),

    // ── By user (3 lists) ─────────────────────────────────────────
    buildSection(AREA, "Top Credited Users", userColumns, () => userRows(byUser().topCredited)),
    buildSection(AREA, "Top Debited Users", userColumns, () => userRows(byUser().topDebited)),
    buildSection(AREA, "High-Frequency Adjustment Users", userColumns, () =>
      userRows(byUser().highFrequency),
    ),

    // ── Audit trail (deeper than UI) ──────────────────────────────
    buildSection(
      AREA,
      auditName,
      [
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
      () =>
        audit().rows.map((r) => [
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
    ),
  ];
}
