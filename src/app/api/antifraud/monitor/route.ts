import { requireAntifraudReadAccess } from "@/lib/require-antifraud-access";
import { buildCacheKey, rateLimit } from "@/lib/cache/redis";
import { buildAntifraudMonitorSnapshot } from "@/lib/antifraud/monitor-snapshot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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

  try {
    // Shape, degradation map and field names all live in the shared builder —
    // /antifraud/monitor renders its first paint from the exact same object.
    return Response.json(await buildAntifraudMonitorSnapshot(), {
      headers: { "Cache-Control": "no-store" },
    });
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
