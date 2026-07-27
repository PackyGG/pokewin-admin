import { requireAntifraudAccess } from "@/lib/require-antifraud-access";
import { buildCacheKey, rateLimit } from "@/lib/cache/redis";

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
    const session = await requireAntifraudAccess();
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
        flows: { active: 0, total: 0, names: [] },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const [live, cases, rules] = await Promise.all([
      upstreamJson(baseUrl, token, "/v1/monitors/live"),
      upstreamJson(baseUrl, token, "/v1/cases?limit=40"),
      upstreamJson(baseUrl, token, "/v1/rules"),
    ]);
    return Response.json(
      {
        configured: true,
        live:
          live && typeof live === "object" && "data" in live
            ? (live as { data: unknown }).data
            : [],
        cases:
          cases && typeof cases === "object" && "data" in cases
            ? (cases as { data: unknown }).data
            : [],
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
        flows: { active: 0, total: 0, names: [] },
      },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
