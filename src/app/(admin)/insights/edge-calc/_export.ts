import "server-only";

import type { ExportSection } from "@/lib/utils/export-csv";
import {
  getPackEdgeRows,
  getUpgraderEdgeByTarget,
  getUpgraderPoolStats,
} from "@/lib/queries/insights-edge-calc";
import { settle, unwrap, buildSection } from "../_export-section";

const AREA = "insights.export.edge-calc";

/**
 * Export gatherer for /insights/edge-calc.
 *
 * Edge-calc is a theoretical EV / RTP / house-edge surface with no
 * period dimension. The export bundles the three server-backed
 * datasets: the per-pack EV table (theoretical vs empirical RTP +
 * house edge + the inputs the Scenario / Bonus calculators consume),
 * the per-target upgrader edge table (empirical vs theoretical), and
 * the upgrader output-pool stats.
 *
 * The Scenario and Bonus tabs are interactive client-side calculators
 * whose only server input is the pack list — fully captured by the
 * "Pack Edge" section here, so a downstream sheet can reproduce any
 * scenario from the exported inputs.
 *
 * Reuses the exact same cached query helpers the page renders.
 * Read-only against the Main DB. Server-only; auth is enforced by the
 * route handler that calls this (`/insights/export`), which gates on the
 * same page-access key as the page.
 */
export async function gatherEdgeCalcExportSections(): Promise<ExportSection[]> {
  // Settle (not await-throw) so one failed query degrades only its own
  // section instead of crashing the gatherer → BOM-only download.
  const [packsR, upgraderR, poolR] = await settle([
    getPackEdgeRows(),
    getUpgraderEdgeByTarget(),
    getUpgraderPoolStats(),
  ]);
  const packs = () => unwrap(packsR);
  const upgrader = () => unwrap(upgraderR);
  const pool = () => unwrap(poolR);

  return [
    // ── Pack edge / EV table ──────────────────────────────────────
    buildSection(
      AREA,
      "Pack Edge (theoretical vs empirical)",
      [
        "Pack ID",
        "Name",
        "Slug",
        "Price (USD)",
        "Cards per open",
        "Pool size",
        "Total weight",
        "Expected card value (USD)",
        "Expected payout per open (USD)",
        "Theoretical RTP",
        "Theoretical house edge",
        "Total openings",
        "Total revenue (USD)",
        "Total payout (USD)",
        "Empirical RTP",
        "Empirical house edge",
        "Active",
        "Min card price (USD)",
        "Max card price (USD)",
      ],
      () =>
        packs().map((p) => [
          p.id,
          p.name,
          p.slug,
          p.priceUsd,
          p.cardsPerOpen,
          p.poolSize,
          p.totalWeight,
          p.expectedCardValue,
          p.expectedPayoutPerOpen,
          p.theoreticalRtp,
          p.theoreticalHouseEdge,
          p.totalOpenings,
          p.totalRevenue,
          p.totalPayout,
          p.empiricalRtp,
          p.empiricalHouseEdge,
          p.active ? "yes" : "no",
          p.minCardPrice,
          p.maxCardPrice,
        ]),
    ),

    // ── Upgrader edge by target ───────────────────────────────────
    buildSection(
      AREA,
      "Upgrader Edge by Target Multiplier",
      [
        "Multiplier",
        "Bets",
        "Wins",
        "Wager (USD)",
        "Payouts (USD)",
        "Hit rate",
        "Empirical house edge",
        "Theoretical chance",
      ],
      () =>
        upgrader().map((r) => [
          r.multiplier,
          r.bets,
          r.wins,
          r.wager,
          r.payouts,
          r.hitRate,
          r.empiricalHouseEdge,
          r.theoreticalChance,
        ]),
    ),

    // ── Upgrader pool stats ───────────────────────────────────────
    buildSection(AREA, "Upgrader Output Pool Stats", ["Metric", "Value"], () => {
      const p = pool();
      return [
        ["Pool size", p.poolSize],
        ["Enabled count", p.enabledCount],
        ["Enabled value total (USD)", p.enabledValueTotal],
        ["Min enabled price (USD)", p.minEnabledPrice],
        ["Max enabled price (USD)", p.maxEnabledPrice],
        ["Distinct prices", p.distinctPrices],
      ];
    }),
  ];
}
