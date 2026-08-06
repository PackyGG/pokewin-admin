import "server-only";

import { sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";

import { adminDrizzle } from "@/lib/admin-db";
import { pgArrayParam } from "@/lib/drizzle-array-param";
import {
  NON_ACTIONABLE_REWARD_ENROLLMENT_SIGNAL_KINDS,
  reviewSignalLabel,
} from "./signal-display";
import { REVIEW_SEVERITIES, type ReviewSeverity } from "./constants";

/**
 * The two operational reads behind the dashboard's lower half.
 *
 * Everything here is ADMIN-DB only — the case table and the signal table — so
 * neither read touches MAIN and neither can be slowed by the mirror. Both are
 * bounded to the same 30-day window the rest of the dashboard uses.
 *
 * Index coverage, stated honestly:
 *   • `antifraud_reviews_created_idx` (`created_at DESC`) serves every
 *     `created_at`-bounded arm: the opened-per-day series and the risk-band
 *     breakdown.
 *   • `antifraud_signals_received_idx` (`received_at DESC`) serves the
 *     detection-mix scan.
 *   • The `resolved_at`-bounded arms (decided-per-day, decision latency) have
 *     no dedicated index, so the planner walks the case table. That is the
 *     same choice the shipped `overview.ts` "caught per day" query already
 *     makes on this table, and `antifraud_reviews` is a small operational
 *     table (one row per opened case, not per event) — it is deliberately not
 *     worth a fourth index on a table that is written on every case decision.
 *     If the case table ever grows past the low hundreds of thousands, add
 *     `(resolved_at DESC) WHERE resolved_at IS NOT NULL` as an admin
 *     migration and revisit.
 */

const CASE_QUEUE_STATUSES = ["open", "in_review", "escalated"] as const;

export type CaseThroughputDay = {
  date: string;
  opened: number;
  cleared: number;
  flagged: number;
};

export type AntifraudCaseThroughput = {
  days: CaseThroughputDay[];
  openedTotal: number;
  clearedTotal: number;
  flaggedTotal: number;
  /** Minutes from case creation to decision, over cases decided in-window. */
  medianDecisionMinutes: number | null;
  p90DecisionMinutes: number | null;
  /** Age of the oldest case still waiting for a decision, in hours. */
  oldestOpenHours: number | null;
};

export type DetectionKind = {
  kind: string;
  label: string;
  total30d: number;
  last7d: number;
  lastSeenAt: string | null;
};

export type RiskBandOutcome = {
  severity: ReviewSeverity;
  cases: number;
  flagged: number;
  cleared: number;
  open: number;
};

export type AntifraudDetectionHealth = {
  kinds: DetectionKind[];
  totalSignals30d: number;
  bands: RiskBandOutcome[];
};

function numeric(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumeric(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type ThroughputRow = {
  bucket: string;
  opened: string;
  cleared: string;
  flagged: string;
  p50_minutes: string | null;
  p90_minutes: string | null;
  oldest_open_hours: string | null;
};

async function computeCaseThroughput(): Promise<AntifraudCaseThroughput> {
  const result = await adminDrizzle.execute<ThroughputRow>(sql`
    WITH days AS (
      SELECT generate_series(
        date_trunc('day', now() AT TIME ZONE 'UTC') - interval '29 days',
        date_trunc('day', now() AT TIME ZONE 'UTC'),
        interval '1 day'
      )::date AS bucket
    ),
    opened AS (
      SELECT
        (created_at AT TIME ZONE 'UTC')::date AS bucket,
        COUNT(*) AS total
      FROM antifraud_reviews
      WHERE created_at >=
          date_trunc('day', now() AT TIME ZONE 'UTC') - interval '29 days'
        AND created_at <
          date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day'
      GROUP BY 1
    ),
    decided AS (
      SELECT
        (resolved_at AT TIME ZONE 'UTC')::date AS bucket,
        COUNT(*) FILTER (WHERE status = 'cleared') AS cleared,
        COUNT(*) FILTER (WHERE status = 'flagged') AS flagged
      FROM antifraud_reviews
      WHERE resolved_at >=
          date_trunc('day', now() AT TIME ZONE 'UTC') - interval '29 days'
        AND resolved_at <
          date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day'
      GROUP BY 1
    ),
    latency AS (
      SELECT
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60
        ) AS p50,
        percentile_cont(0.9) WITHIN GROUP (
          ORDER BY EXTRACT(EPOCH FROM (resolved_at - created_at)) / 60
        ) AS p90
      FROM antifraud_reviews
      WHERE resolved_at >=
          date_trunc('day', now() AT TIME ZONE 'UTC') - interval '29 days'
        AND resolved_at <
          date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day'
        -- A backfilled row can carry a resolved_at before its created_at.
        -- Negative latencies would drag the percentiles below zero.
        AND resolved_at >= created_at
    ),
    oldest AS (
      SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at))) / 3600 AS hours
      FROM antifraud_reviews
      WHERE status = ANY(${pgArrayParam([...CASE_QUEUE_STATUSES])}::text[])
    )
    SELECT
      days.bucket::text AS bucket,
      COALESCE(opened.total, 0)::text AS opened,
      COALESCE(decided.cleared, 0)::text AS cleared,
      COALESCE(decided.flagged, 0)::text AS flagged,
      (SELECT p50 FROM latency)::text AS p50_minutes,
      (SELECT p90 FROM latency)::text AS p90_minutes,
      (SELECT hours FROM oldest)::text AS oldest_open_hours
    FROM days
    LEFT JOIN opened USING (bucket)
    LEFT JOIN decided USING (bucket)
    ORDER BY days.bucket
  `);

  const days: CaseThroughputDay[] = result.rows.map((row) => ({
    date: row.bucket,
    opened: numeric(row.opened),
    cleared: numeric(row.cleared),
    flagged: numeric(row.flagged),
  }));
  const head = result.rows[0];

  return {
    days,
    openedTotal: days.reduce((sum, day) => sum + day.opened, 0),
    clearedTotal: days.reduce((sum, day) => sum + day.cleared, 0),
    flaggedTotal: days.reduce((sum, day) => sum + day.flagged, 0),
    medianDecisionMinutes: optionalNumeric(head?.p50_minutes),
    p90DecisionMinutes: optionalNumeric(head?.p90_minutes),
    oldestOpenHours: optionalNumeric(head?.oldest_open_hours),
  };
}

type DetectionKindRow = {
  kind: string;
  total: string;
  last7: string;
  last_seen: string | null;
};

type RiskBandRow = {
  severity: string;
  cases: string;
  flagged: string;
  cleared: string;
  open: string;
};

async function computeDetectionHealth(): Promise<AntifraudDetectionHealth> {
  const [kindResult, bandResult] = await Promise.all([
    adminDrizzle.execute<DetectionKindRow>(sql`
      SELECT
        kind,
        COUNT(*)::text AS total,
        COUNT(*) FILTER (
          WHERE received_at >= now() - interval '7 days'
        )::text AS last7,
        MAX(received_at)::text AS last_seen
      FROM antifraud_signals
      WHERE received_at >= now() - interval '30 days'
        AND NOT (
          kind = ANY(${pgArrayParam([
            ...NON_ACTIONABLE_REWARD_ENROLLMENT_SIGNAL_KINDS,
          ])}::text[])
        )
      GROUP BY kind
      ORDER BY COUNT(*) DESC, kind
      LIMIT 10
    `),
    adminDrizzle.execute<RiskBandRow>(sql`
      SELECT
        severity,
        COUNT(*)::text AS cases,
        COUNT(*) FILTER (WHERE status = 'flagged')::text AS flagged,
        COUNT(*) FILTER (WHERE status = 'cleared')::text AS cleared,
        COUNT(*) FILTER (
          WHERE status = ANY(${pgArrayParam([
            ...CASE_QUEUE_STATUSES,
          ])}::text[])
        )::text AS open
      FROM antifraud_reviews
      WHERE created_at >= now() - interval '30 days'
      GROUP BY severity
    `),
  ]);

  const kinds: DetectionKind[] = kindResult.rows.map((row) => ({
    kind: row.kind,
    label: reviewSignalLabel(row.kind),
    total30d: numeric(row.total),
    last7d: numeric(row.last7),
    lastSeenAt: row.last_seen,
  }));

  const byBand = new Map(bandResult.rows.map((row) => [row.severity, row]));
  const bands: RiskBandOutcome[] = REVIEW_SEVERITIES.map((severity) => {
    const row = byBand.get(severity);
    return {
      severity,
      cases: numeric(row?.cases),
      flagged: numeric(row?.flagged),
      cleared: numeric(row?.cleared),
      open: numeric(row?.open),
    };
  });

  return {
    kinds,
    totalSignals30d: kinds.reduce((sum, kind) => sum + kind.total30d, 0),
    bands,
  };
}

const cachedCaseThroughput = unstable_cache(
  computeCaseThroughput,
  ["antifraud-case-throughput-v1"],
  { revalidate: 60, tags: ["antifraud-overview"] },
);

const cachedDetectionHealth = unstable_cache(
  computeDetectionHealth,
  ["antifraud-detection-health-v1"],
  { revalidate: 60, tags: ["antifraud-overview"] },
);

export function getAntifraudCaseThroughput(): Promise<AntifraudCaseThroughput> {
  return cachedCaseThroughput();
}

export function getAntifraudDetectionHealth(): Promise<AntifraudDetectionHealth> {
  return cachedDetectionHealth();
}
