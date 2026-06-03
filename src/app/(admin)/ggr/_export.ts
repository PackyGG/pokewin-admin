import "server-only";

import type { ExportSection } from "@/lib/utils/export-csv";
import { DASHBOARD_PERIOD_LABELS } from "@/lib/queries/dashboard-period";
import {
  getGgrPageData,
  getGgrTopContributors,
  ggrWindowToMetricWindow,
} from "@/lib/queries/ggr";
import { describeLedgerType } from "@/lib/queries/_wager-payout-descriptions";
import {
  settle,
  unwrap,
  buildSection,
} from "../insights/_export-section";

const AREA = "insights.export.ggr";

/** Windows the /ggr page exposes — same coercion as the page. `all` is the
 * Lifetime bucket (mapped to an unbounded lookback by
 * `ggrWindowToMetricWindow`). */
export type GgrWindow = "24h" | "3d" | "7d" | "all";

/** Supported `?window=` values for /ggr — mirrors the page's set. */
export const GGR_EXPORT_WINDOWS = ["24h", "3d", "7d", "all"] as const;

/**
 * Coerce a raw `window` param to a valid {@link GgrWindow}. Mirrors the
 * page's `parseGgrWindow` so the export and the page agree on the window
 * for any URL — including the `all` (Lifetime) bucket, so an export taken
 * from the Lifetime view exports lifetime data rather than silently
 * falling back to 24h. Unknown values fall back to the page default
 * (`24h`).
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
 * Bundles the canonical GGR/NGR rollup (upgrader included), the gaming
 * payout legs, the neutral-conversion and reward-giveback per-type
 * breakdowns, and the top contributors for the active window into one
 * CSV. Reuses the EXACT same `getGgrPageData` + `getGgrTopContributors`
 * helpers the page renders, so the export reconciles with the headline
 * numbers. The contributor list is pulled at 50 (the UI shows 10).
 *
 * Read-only; server-only; auth is enforced by the route handler that
 * calls this (`/insights/export`), which gates on the same page-access
 * key as the page (`/ggr`).
 */
export async function gatherGgrExportSections(
  ggrWindow: GgrWindow,
): Promise<ExportSection[]> {
  const metricWindow = ggrWindowToMetricWindow(ggrWindow);

  // Settle (not await-throw) so one failed query degrades only its own
  // section(s) instead of crashing the gatherer → BOM-only download.
  const [dataR, contributorsR] = await settle([
    getGgrPageData(metricWindow),
    getGgrTopContributors(metricWindow, 50),
  ]);
  const data = () => unwrap(dataR);
  const contributors = () => unwrap(contributorsR);

  const periodLabel = DASHBOARD_PERIOD_LABELS[ggrWindow];

  return [
    // ── Headline rollup (upgrader included) ───────────────────────
    buildSection(AREA, `GGR Summary (${periodLabel})`, ["Metric", "Value"], () => {
      const d = data();
      return [
        ["Window", periodLabel],
        ["Total wager (USD)", d.headline.wager],
        ["Gaming payout (USD)", d.headline.gamingPayout],
        ["GGR / wager − payout (USD)", d.headline.ggr],
        ["NGR / GGR − reward giveback (USD)", d.headline.ngr],
        ["House edge %", d.headline.houseEdge === null ? "n/a" : d.headline.houseEdge * 100],
        ["RTP %", d.headline.rtp === null ? "n/a" : d.headline.rtp * 100],
        ["Bets", d.headline.bets],
        ["Upgrader available", d.upgraderAvailable ? "yes" : "no"],
      ];
    }),

    // ── Gaming payout legs ────────────────────────────────────────
    buildSection(
      AREA,
      "Gaming Payout Legs",
      ["Leg", "Total (USD)", "Share of payouts %"],
      () => {
        const d = data();
        return d.gaming.legs.map((leg) => [
          leg.label,
          leg.total,
          d.gaming.payoutTotal > 0 ? (leg.total / d.gaming.payoutTotal) * 100 : 0,
        ]);
      },
    ),

    // ── Neutral conversions (NOT house cost) ──────────────────────
    buildSection(
      AREA,
      "Neutral Conversions (user disposals, not house cost)",
      ["Type", "Label", "Total (USD)", "Share of conversions %"],
      () => {
        const d = data();
        return d.neutral.rows.map((r) => [
          r.type,
          r.label ?? describeLedgerType(r.type).label,
          r.total,
          d.neutral.total > 0 ? (r.total / d.neutral.total) * 100 : 0,
        ]);
      },
    ),

    // ── Reward giveback (reduces NGR) ─────────────────────────────
    buildSection(
      AREA,
      "Reward Giveback (reduces NGR)",
      ["Type", "Label", "Total gross (USD)", "Share of giveback %"],
      () => {
        const d = data();
        return d.reward.rows.map((r) => [
          r.type,
          r.label ?? describeLedgerType(r.type).label,
          r.total,
          d.reward.total > 0 ? (r.total / d.reward.total) * 100 : 0,
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
