import { requireAntifraudReadAccess } from "@/lib/require-antifraud-access";
import { buildCacheKey, rateLimit } from "@/lib/cache/redis";
import { listAntifraudBannedUsers } from "@/lib/antifraud/profiles-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Scroll pagination feed for `/antifraud/banned-users`. The page still renders
 * page 1 server-side; this route only serves the follow-up pages the client
 * appends when the sentinel scrolls into view. Same read gate + CSRF posture as
 * the monitor snapshot route.
 */
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
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  const limit = await rateLimit(
    buildCacheKey("ratelimit:antifraud-banned-users", [actorId]),
    120,
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

  const rawPage = Number(url.searchParams.get("page"));
  const page =
    Number.isInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, 10_000) : 1;
  const rawSearch = url.searchParams.get("search")?.trim();
  const result = await listAntifraudBannedUsers({
    page,
    search: rawSearch ? rawSearch.slice(0, 100) : undefined,
  });
  if (!result.configured || result.error) {
    return Response.json(
      { error: "banned_users_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return Response.json(
    { data: result.data, pagination: result.pagination },
    { headers: { "Cache-Control": "no-store" } },
  );
}
