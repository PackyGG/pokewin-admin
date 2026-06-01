import "server-only";

import type { ExportSection } from "@/lib/utils/export-csv";
import {
  getGgrBreakdown,
  getGgrTopContributors,
  DASHBOARD_PERIOD_LABELS,
  type DashboardPeriod,
} from "@/lib/queries/dashboard";
import { describeLedgerType } from "@/lib/queries/_wager-payout-descriptions";
import {
  settle,
  unwrap,
  buildSection,
} from "../insights/_export-section";

const AREA = "insights.export.ggr";

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
  // Settle (not await-throw) so one failed query degrades only its own
  // section(s) instead of crashing the gatherer → BOM-only download.
  const [breakdownR, contributorsR] = await settle([
    getGgrBreakdown(ggrWindow),
    getGgrTopContributors(ggrWindow, 50),
  ]);
  const breakdown = () => unwrap(breakdownR);
  const contributors = () => unwrap(contributorsR);

  const periodLabel = DASHBOARD_PERIOD_LABELS[ggrWindow];

  return [
    // ── GGR rollup ────────────────────────────────────────────────
    buildSection(AREA, `GGR Summary (${periodLabel})`, ["Metric", "Value"], () => {
      const b = breakdown();
      return [
        ["Window", periodLabel],
        ["Total wagers (USD)", b.wagersTotal],
        ["Total payouts (USD)", b.payoutsTotal],
        ["GGR / wagers − payouts (USD)", b.ggr],
      ];
    }),

    // ── Wager-side breakdown by ledger type ───────────────────────
    buildSection(
      AREA,
      "Wagers by Ledger Type",
      ["Type", "Label", "Total (USD)", "Share of wagers %"],
      () => {
        const b = breakdown();
        return b.wagers.map((r) => [
          r.type,
          describeLedgerType(r.type).label,
          r.total,
          b.wagersTotal > 0 ? (r.total / b.wagersTotal) * 100 : 0,
        ]);
      },
    ),

    // ── Payout-side breakdown by ledger type ──────────────────────
    buildSection(
      AREA,
      "Payouts by Ledger Type",
      ["Type", "Label", "Total (USD)", "Share of payouts %"],
      () => {
        const b = breakdown();
        return b.payouts.map((r) => [
          r.type,
          describeLedgerType(r.type).label,
          r.total,
          b.payoutsTotal > 0 ? (r.total / b.payoutsTotal) * 100 : 0,
        ]);
      },
    ),

    // ── Top contributors (house-POV net) ──────────────────────────
    buildSection(
      AREA,
      "Top Contributors (top 50, house-POV net)",
      ["User ID", "Username", "Wagers (USD)", "Payouts (USD)", "Net house-POV (USD)"],
      () =>
        contributors().map((r) => [
          r.userId,
          r.username,
          r.wagerTotal,
          r.payoutTotal,
          r.net,
        ]),
    ),
  ];
}
