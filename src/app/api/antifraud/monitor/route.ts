import { requireAntifraudReadAccess } from "@/lib/require-antifraud-access";
import { buildCacheKey, rateLimit } from "@/lib/cache/redis";
import { getAntifraudLiveMirrorMetrics } from "@/lib/antifraud/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UPSTREAM_TIMEOUT_MS = 8_000;

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

export async function GET(request: Request): Promise<Response> {
  let actorId: string;
  try {
    const session = await requireAntifraudReadAccess();
    actorId = session.userId;
  } catch {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const limit = await rateLimit(
    buildCacheKey("ratelimit:antifraud-monitor-snapshot", [actorId]),
    60,
    60,
  );
  if (!limit.allowed) {
    return Response.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: limit.resetSeconds
          ? { "Retry-After": String(limit.resetSeconds) }
          : undefined,
      },
    );
  }

  const { baseUrl, token } = monitorConfig();
  if (!baseUrl || !token) {
    return Response.json(
      {
        configured: false,
        live: [],
        cases: [],
        recentSessions: [],
        summary: null,
        liveMetrics: null,
        flows: { active: 0, total: 0, names: [] },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const [liveResult, casesResult, rulesResult, overviewResult, metricsResult] =
      await Promise.allSettled([
      upstreamJson(baseUrl, token, "/v1/monitors/live"),
      upstreamJson(baseUrl, token, "/v1/cases?limit=40"),
      upstreamJson(baseUrl, token, "/v1/rules"),
      upstreamJson(baseUrl, token, "/v1/overview"),
      getAntifraudLiveMirrorMetrics(),
    ]);
    const live = liveResult.status === "fulfilled" ? liveResult.value : null;
    const cases =
      casesResult.status === "fulfilled" ? casesResult.value : null;
    const rules = rulesResult.status === "fulfilled" ? rulesResult.value : null;
    const overview =
      overviewResult.status === "fulfilled" ? overviewResult.value : null;
    const liveMetrics =
      metricsResult.status === "fulfilled" ? metricsResult.value : null;
    const overviewData =
      overview && typeof overview === "object" && "data" in overview
        ? (overview as { data: unknown }).data
        : null;
    const overviewRecord =
      overviewData && typeof overviewData === "object"
        ? (overviewData as Record<string, unknown>)
        : null;
    const errors = {
      live: liveResult.status === "rejected",
      cases: casesResult.status === "rejected",
      flows: rulesResult.status === "rejected",
      overview: overviewResult.status === "rejected",
      liveMetrics: metricsResult.status === "rejected",
    };
    return Response.json(
      {
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
        casesTruncated:
          cases &&
          typeof cases === "object" &&
          "pagination" in cases &&
          Boolean(
            (cases as { pagination?: { hasMore?: unknown } }).pagination
              ?.hasMore,
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
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("[antifraud-monitor] snapshot failed:", error);
    return Response.json(
      {
        configured: true,
        error: "monitor_unavailable",
        live: [],
        cases: [],
        recentSessions: [],
        summary: null,
        liveMetrics: null,
        flows: { active: 0, total: 0, names: [] },
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
