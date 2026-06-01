import "server-only";

import type { ExportSection } from "@/lib/utils/export-csv";
import {
  getGgrBreakdown,
  getGgrTopContributors,
  DASHBOARD_PERIOD_LABELS,
  type DashboardPeriod,
} from "@/lib/queries/dashboard";
import { describeLedgerType } from "@/lib/queries/_wager-payout-descriptions";

/** Windows the /ggr page exposes — same coercion as the page. */
export type GgrWindow = Extract<DashboardPeriod, "24h" | "3d" | "7d">;

/** Supported `?window=` values for /ggr — mirrors the page's set. */
export const GGR_EXPORT_WINDOWS = ["24h", "3d", "7d"] as const;

/**
 * Coerce a raw `window` param to a valid {@link GgrWindow}. Mirrors the
 * page's `parseGgrWindow` so the export and the page agree on the window
 * for any URL. Unknown values fall back to the page default (`24h`).
 */
export function parseGgrExportWindow(value: string | undefined): GgrWindow {
  if (!value) return "24h";
  return (GGR_EXPORT_WINDOWS as readonly string[]).includes(value)
    ? (value as GgrWindow)
    : "24h";
}

/**
 * Export gatherer for /ggr.
 *
 * Bundles the GGR rollup (wagers / payouts / GGR), the per-ledger-type
 * wager + payout breakdown (with the canonical type description), and
 * the top contributors for the active window into one CSV.
 *
 * Reuses the exact same cached `getGgrBreakdown` + `getGgrTopContributors`
 * helpers the page renders so the export reconciles with the headline
 * numbers. The contributor list is bounded at 50 (the query's internal
 * cap; the UI shows 10) — the export pulls the full 50. Read-only.
 * Server-only; auth is enforced by the route handler that calls this
 * (`/insights/export`), which gates on the same page-access key as the
 * page.
 */
export async function gatherGgrExportSections(
  ggrWindow: GgrWindow,
): Promise<ExportSection[]> {
  const [breakdown, contributors] = await Promise.all([
    getGgrBreakdown(ggrWindow),
    getGgrTopContributors(ggrWindow, 50),
  ]);

  const periodLabel = DASHBOARD_PERIOD_LABELS[ggrWindow];
  const sections: ExportSection[] = [];

  // ── GGR rollup ──────────────────────────────────────────────────
  sections.push({
    name: `GGR Summary (${periodLabel})`,
    columns: ["Metric", "Value"],
    rows: [
      ["Window", periodLabel],
      ["Total wagers (USD)", breakdown.wagersTotal],
      ["Total payouts (USD)", breakdown.payoutsTotal],
      ["GGR / wagers − payouts (USD)", breakdown.ggr],
    ],
  });

  // ── Wager-side breakdown by ledger type ─────────────────────────
  sections.push({
    name: "Wagers by Ledger Type",
    columns: ["Type", "Label", "Total (USD)", "Share of wagers %"],
    rows: breakdown.wagers.map((r) => [
      r.type,
      describeLedgerType(r.type).label,
      r.total,
      breakdown.wagersTotal > 0
        ? (r.total / breakdown.wagersTotal) * 100
        : 0,
    ]),
  });

  // ── Payout-side breakdown by ledger type ────────────────────────
  sections.push({
    name: "Payouts by Ledger Type",
    columns: ["Type", "Label", "Total (USD)", "Share of payouts %"],
    rows: breakdown.payouts.map((r) => [
      r.type,
      describeLedgerType(r.type).label,
      r.total,
      breakdown.payoutsTotal > 0
        ? (r.total / breakdown.payoutsTotal) * 100
        : 0,
    ]),
  });

  // ── Top contributors (house-POV net) ────────────────────────────
  sections.push({
    name: "Top Contributors (top 50, house-POV net)",
    columns: [
      "User ID",
      "Username",
      "Wagers (USD)",
      "Payouts (USD)",
      "Net house-POV (USD)",
    ],
    rows: contributors.map((r) => [
      r.userId,
      r.username,
      r.wagerTotal,
      r.payoutTotal,
      r.net,
    ]),
  });

  return sections;
}
