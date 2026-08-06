import "server-only";

import {
  getAntifraudLive24hMetrics,
  type AntifraudLiveMirrorMetrics,
} from "@/lib/antifraud/overview";
import { getAntifraudMonitorOverview } from "@/lib/antifraud/monitor-api";

/**
 * The one snapshot the live monitor console paints from.
 *
 * It lives here rather than inside the route handler because BOTH the route
 * (`/api/antifraud/monitor`, the console's resync path) and the page
 * (`/antifraud/monitor`, the server-rendered first paint) need it, and the two
 * must never drift: the console parses one shape, field for field.
 *
 * Everything in the returned object is a plain JSON value — it is handed
 * straight to `Response.json()` on one side and passed as a Server → Client
 * prop on the other, so no class instance, `Date`, or function may enter it.
 */

const UPSTREAM_TIMEOUT_MS = 8_000;

export type AntifraudMonitorSnapshotSummary = {
  signupReviewsLeft: number;
  fiatReviewsLeft: number;
  activeDomainBlacklist: number;
  blockedIpCatches: number;
};

export type AntifraudMonitorSnapshot = {
  configured: boolean;
  degraded?: boolean;
  errors?: Record<
    "live" | "cases" | "flows" | "overview" | "liveMetrics",
    boolean
  >;
  live: unknown;
  cases: unknown;
  casesTruncated?: boolean;
  recentSessions: unknown;
  summary: AntifraudMonitorSnapshotSummary | null;
  liveMetrics: AntifraudLiveMirrorMetrics | null;
  flows: { active: number; total: number; names: string[] };
};

function monitorConfig(): { baseUrl?: string; token?: string } {
  return {
    baseUrl: process.env.ANTIFRAUD_MONITOR_API_URL?.replace(/\/+$/, ""),
    token: process.env.ANTIFRAUD_MONITOR_API_TOKEN,
  };
}

async function upstreamJson(baseUrl: string, token: string, path: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Monitor API returned ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

function flowMonitoring(value: unknown): {
  active: number;
  total: number;
  names: string[];
} {
  const data =
    value && typeof value === "object" && "data" in value
      ? (value as { data: unknown }).data
      : [];
  const rows = Array.isArray(data) ? data : [];
  const activeRows = rows.filter(
    (row) =>
      row &&
      typeof row === "object" &&
      (row as { enabled?: unknown }).enabled === true,
  );
  return {
    active: activeRows.length,
    total: rows.length,
    names: activeRows
      .map((row) =>
        typeof (row as { name?: unknown }).name === "string"
          ? (row as { name: string }).name
          : "",
      )
      .filter(Boolean)
      .slice(0, 8),
  };
}

export async function buildAntifraudMonitorSnapshot(): Promise<AntifraudMonitorSnapshot> {
  const { baseUrl, token } = monitorConfig();
  if (!baseUrl || !token) {
    return {
      configured: false,
      live: [],
      cases: [],
      recentSessions: [],
      summary: null,
      liveMetrics: null,
      flows: { active: 0, total: 0, names: [] },
    };
  }

  // Overview goes through the `cache()`-wrapped accessor instead of a raw
  // fetch: `getAntifraudLive24hMetrics` reads the same endpoint internally, so
  // the raw call here doubled every heavy overview query.
  const [liveResult, casesResult, rulesResult, overviewResult, metricsResult] =
    await Promise.allSettled([
      upstreamJson(baseUrl, token, "/v1/monitors/live"),
      upstreamJson(baseUrl, token, "/v1/cases?limit=40"),
      upstreamJson(baseUrl, token, "/v1/rules"),
      getAntifraudMonitorOverview(),
      getAntifraudLive24hMetrics(),
    ]);
  const live = liveResult.status === "fulfilled" ? liveResult.value : null;
  const cases = casesResult.status === "fulfilled" ? casesResult.value : null;
  const rules = rulesResult.status === "fulfilled" ? rulesResult.value : null;
  const overview =
    overviewResult.status === "fulfilled" ? overviewResult.value : null;
  const liveMetrics =
    metricsResult.status === "fulfilled" ? metricsResult.value : null;
  const overviewRecord = overview?.data ?? null;
  const errors = {
    live: liveResult.status === "rejected",
    cases: casesResult.status === "rejected",
    flows: rulesResult.status === "rejected",
    overview: overviewResult.status === "rejected" || !overviewRecord,
    liveMetrics: metricsResult.status === "rejected",
  };

  return {
    configured: true,
    degraded: Object.values(errors).some(Boolean),
    errors,
    live:
      live && typeof live === "object" && "data" in live
        ? (live as { data: unknown }).data
        : [],
    cases:
      cases && typeof cases === "object" && "data" in cases
        ? (cases as { data: unknown }).data
        : [],
    casesTruncated: Boolean(
      cases &&
        typeof cases === "object" &&
        "pagination" in cases &&
        (cases as { pagination?: { hasMore?: unknown } }).pagination?.hasMore,
    ),
    recentSessions: Array.isArray(overviewRecord?.recentSessions)
      ? overviewRecord.recentSessions
      : [],
    summary: overviewRecord
      ? {
          signupReviewsLeft: overviewRecord.signupReviewsLeft,
          fiatReviewsLeft: overviewRecord.fiatReviewsLeft,
          activeDomainBlacklist: overviewRecord.activeDomainBlacklist,
          blockedIpCatches: overviewRecord.blockedIpCatches,
        }
      : null,
    liveMetrics,
    flows: flowMonitoring(rules),
  };
}
