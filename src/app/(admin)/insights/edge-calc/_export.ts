"use server";

import { requirePageAccess } from "@/lib/dal";
import type { ExportSection } from "@/lib/utils/export-csv";
import {
  getPackEdgeRows,
  getUpgraderEdgeByTarget,
  getUpgraderPoolStats,
} from "@/lib/queries/insights-edge-calc";

/**
 * Server export action for /insights/edge-calc.
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
 * Read-only against the Main DB. Gated by the same page-access check as
 * the page.
 */
export async function exportEdgeCalcData(): Promise<ExportSection[]> {
  await requirePageAccess("/insights/edge-calc");

  const [packs, upgrader, pool] = await Promise.all([
    getPackEdgeRows(),
    getUpgraderEdgeByTarget(),
    getUpgraderPoolStats(),
  ]);

  const sections: ExportSection[] = [];

  // ── Pack edge / EV table ────────────────────────────────────────
  sections.push({
    name: "Pack Edge (theoretical vs empirical)",
    columns: [
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
    rows: packs.map((p) => [
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
  });

  // ── Upgrader edge by target ─────────────────────────────────────
  sections.push({
    name: "Upgrader Edge by Target Multiplier",
    columns: [
      "Multiplier",
      "Bets",
      "Wins",
      "Wager (USD)",
      "Payouts (USD)",
      "Hit rate",
      "Empirical house edge",
      "Theoretical chance",
    ],
    rows: upgrader.map((r) => [
      r.multiplier,
      r.bets,
      r.wins,
      r.wager,
      r.payouts,
      r.hitRate,
      r.empiricalHouseEdge,
      r.theoreticalChance,
    ]),
  });

  // ── Upgrader pool stats ─────────────────────────────────────────
  sections.push({
    name: "Upgrader Output Pool Stats",
    columns: ["Metric", "Value"],
    rows: [
      ["Pool size", pool.poolSize],
      ["Enabled count", pool.enabledCount],
      ["Enabled value total (USD)", pool.enabledValueTotal],
      ["Min enabled price (USD)", pool.minEnabledPrice],
      ["Max enabled price (USD)", pool.maxEnabledPrice],
      ["Distinct prices", pool.distinctPrices],
    ],
  });

  return sections;
}
