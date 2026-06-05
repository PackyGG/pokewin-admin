/**
 * recommend.ts — pure, rule-based scenario summarizer. REWARD-AGNOSTIC.
 *
 * No ML, no heuristics beyond argmax/argmin over the supplied result set.
 * Reads ONLY the generic {@link SimulationResult} shape, so it ranks any
 * reward's scenarios identically. Returns up to three badges:
 *   • highest-savings — max NET savings vs baseline.
 *   • lowest-friction — min friction score.
 *   • best-balance    — max of a normalized composite of net-savings,
 *                       abuse-reduction and (1 − friction).
 *
 * Each recommendation carries human-readable headline + detail with the
 * concrete numbers, so the UI just renders a Badge + text (no formatting logic
 * in the component). Detail strings use the shared formatters so money/percent
 * read identically to the rest of the surface.
 */

import { formatPct, formatSignedUsd } from "../edge-calc/math";
import { formatCurrency } from "@/lib/utils/format";
import { clamp01, safeDiv } from "./engine";
import type { Recommendation, SimulationResult } from "./types";

/** Map a result-set min→max onto 0-1 (higher input → higher output). */
function normalizeAscending(value: number, min: number, max: number): number {
  if (max - min < 1e-9) return 0;
  return clamp01((value - min) / (max - min));
}

/**
 * Compute the recommendation badges for a set of simulated scenarios.
 *
 * The baseline (savings === 0) is excluded from "highest savings" and
 * "best balance" (it never SAVES anything vs itself), but is eligible for
 * "lowest friction" (the baseline usually IS the lowest-friction policy —
 * worth surfacing honestly rather than hiding it).
 */
export function recommend(results: SimulationResult[]): Recommendation[] {
  const out: Recommendation[] = [];
  if (results.length === 0) return out;

  // Candidates that actually deviate from baseline for the savings/balance
  // awards (a baseline row has savingsVsBaseline === 0 by construction).
  const deviating = results.filter((r) => Math.abs(r.savingsVsBaseline) > 1e-9);
  const savingsPool = deviating.length > 0 ? deviating : results;

  // ── highest-savings — max NET savings vs baseline ──
  const bestSavings = savingsPool.reduce((best, r) =>
    r.netSavingsVsBaseline > best.netSavingsVsBaseline ? r : best,
  );
  if (bestSavings.netSavingsVsBaseline > 0) {
    out.push({
      scenarioId: bestSavings.scenarioId,
      badge: "highest-savings",
      headline: "Highest net savings",
      detail: `Saves ${formatCurrency(bestSavings.netSavingsVsBaseline)} net vs baseline (${formatCurrency(
        bestSavings.savingsVsBaseline,
      )} gross, less retained-revenue given up). Abuse leakage ${formatCurrency(bestSavings.abuseLeakage)}.`,
    });
  }

  // ── lowest-friction — min friction across ALL results ──
  const lowestFriction = results.reduce((best, r) =>
    r.frictionScore < best.frictionScore ? r : best,
  );
  out.push({
    scenarioId: lowestFriction.scenarioId,
    badge: "lowest-friction",
    headline: "Lowest friction",
    detail: `Friction score ${lowestFriction.frictionScore.toFixed(0)}/100 — the smoothest claim experience in the set. Projected cost ${formatCurrency(
      lowestFriction.bonusCost,
    )}.`,
  });

  // ── best-balance — normalized composite over the deviating pool ──
  // Axes (all "higher = better"): net savings, abuse reduction (= −leakage,
  // so we invert), and low friction (= −friction, inverted). Each normalized
  // across the pool, averaged equally.
  const pool = savingsPool;
  const netSavings = pool.map((r) => r.netSavingsVsBaseline);
  const leakage = pool.map((r) => r.abuseLeakage);
  const friction = pool.map((r) => r.frictionScore);

  const nsMin = Math.min(...netSavings);
  const nsMax = Math.max(...netSavings);
  const lkMin = Math.min(...leakage);
  const lkMax = Math.max(...leakage);
  const frMin = Math.min(...friction);
  const frMax = Math.max(...friction);

  // Rank every candidate by composite, descending.
  const ranked = pool
    .map((r) => {
      const nsNorm = normalizeAscending(r.netSavingsVsBaseline, nsMin, nsMax);
      // Lower leakage / friction is better → invert the normalized value.
      const abuseNorm = 1 - normalizeAscending(r.abuseLeakage, lkMin, lkMax);
      const fricNorm = 1 - normalizeAscending(r.frictionScore, frMin, frMax);
      return { r, composite: (nsNorm + abuseNorm + fricNorm) / 3 };
    })
    .sort((a, b) => b.composite - a.composite);

  // Prefer a DISTINCT winner from highest-savings when a runner-up exists, so
  // the three badges spread across distinct scenarios "where possible" — but
  // fall back to the true composite winner if it is the only candidate.
  const savingsWinnerId =
    bestSavings.netSavingsVsBaseline > 0 ? bestSavings.scenarioId : null;
  const distinctTop = ranked.find((x) => x.r.scenarioId !== savingsWinnerId);
  const bestBalance = (distinctTop ?? ranked[0]).r;
  out.push({
    scenarioId: bestBalance.scenarioId,
    badge: "best-balance",
    headline: "Best balance",
    detail: `Best blend of net savings (${formatSignedUsd(bestBalance.netSavingsVsBaseline)}), abuse reduction and UX — friction ${bestBalance.frictionScore.toFixed(
      0,
    )}/100, NGR impact ${formatSignedUsd(bestBalance.ngrImpact)}.`,
  });

  return out;
}

/**
 * Convenience: a single rule-based insight line comparing a scenario to the
 * baseline, e.g. for an inline annotation. Pure string builder.
 */
export function describeTradeoff(
  scenario: SimulationResult,
  baseline: SimulationResult,
): string {
  const abuseCut = baseline.abuseLeakage - scenario.abuseLeakage;
  const abuseCutPct = safeDiv(abuseCut, baseline.abuseLeakage);
  const retentionGivenUp = Math.max(0, baseline.retainedRevenue - scenario.retainedRevenue);
  return `Cuts abuse leakage by ${formatPct(abuseCutPct)} (${formatCurrency(
    Math.max(0, abuseCut),
  )}) but gives up ${formatCurrency(retentionGivenUp)} retained revenue → net savings ${formatSignedUsd(
    scenario.netSavingsVsBaseline,
  )}.`;
}
