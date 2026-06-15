import "server-only";

import { logError } from "@/lib/errors/logger";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
import { getAdminReadMode } from "@/lib/feature-flags/admin-read-source";
import type { RetentionData } from "@/lib/queries/analytics-retention";

import { getRetentionCurveFromClickHouse } from "../queries/analytics/retention";
import { computeDrift, logComparison, timeCh } from "./_core";

/**
 * Phase 2B per-surface compare module — /analytics?tab=retention retention /
 * churn curve.
 *
 * Fire-and-forget comparison for `getRetentionCurve`. No-op unless the
 * `analytics_retention` surface is in `comparison` mode (forced `off` whenever
 * ClickHouse is dormant). Runs the dedicated ClickHouse twin with the SAME
 * excluded-users blacklist (replicating the EXACT 2-role + blacklist scope the
 * Postgres twin uses), then diffs the retention COUNTS — every field is an
 * exact count (no money), so all must match exactly:
 *   • cohortD1/D7/D30/D90    — eligible-cohort sizes at each milestone.
 *   • retainedD1/D7/D30/D90  — retained users at each milestone (off the curve).
 *   • curveRetainedSum       — Σ retained over the whole 0..90 curve.
 *   • curveCohortSum         — Σ cohort over the whole 0..90 curve.
 *
 * The per-day `pct` values are derived (retained / cohort) so they are not
 * diffed separately — exact counts on both legs imply exact pct. Swallows every
 * error via `logError` so the served Postgres payload is NEVER affected.
 */
type RetentionLike = {
  curve: { day: number; retained: number; cohort: number }[];
  cohortD1: number;
  cohortD7: number;
  cohortD30: number;
  cohortD90: number;
};

export async function compareRetention(pg: RetentionData): Promise<void> {
  try {
    const mode = await getAdminReadMode("analytics_retention");
    if (mode !== "comparison") return;

    const { result: ch, durationMs } = await timeCh(async () => {
      const blacklist = await getExcludedUserIds();
      return getRetentionCurveFromClickHouse(blacklist);
    });

    const drift = computeDrift(toRecord(pg), toRecord(ch));
    logComparison("analytics.retention", drift, durationMs);
  } catch (err) {
    logError(
      "clickhouse.compare.analytics_retention",
      "comparison failed (ignored)",
      err,
    );
  }
}

/** Flatten a retention curve into the scalar record the drift primitive diffs. */
function toRecord(d: RetentionLike): Record<string, number> {
  const retainedAt = (day: number) =>
    d.curve.find((c) => c.day === day)?.retained ?? 0;
  let curveRetainedSum = 0;
  let curveCohortSum = 0;
  for (const c of d.curve) {
    curveRetainedSum += c.retained;
    curveCohortSum += c.cohort;
  }
  return {
    cohortD1: d.cohortD1,
    cohortD7: d.cohortD7,
    cohortD30: d.cohortD30,
    cohortD90: d.cohortD90,
    retainedD1: retainedAt(1),
    retainedD7: retainedAt(7),
    retainedD30: retainedAt(30),
    retainedD90: retainedAt(90),
    curveRetainedSum,
    curveCohortSum,
  };
}
