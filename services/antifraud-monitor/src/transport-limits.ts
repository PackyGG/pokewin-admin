import type { FastifyRequest } from "fastify";

type RateLimitRequest = Pick<FastifyRequest, "body" | "ip">;

/**
 * The monitor API is called by serverless dashboard instances, so request IP
 * identifies shared Vercel egress rather than one staff member. Ticket limits
 * must follow the authenticated actor carried in the server-only request body.
 */
export function ticketRateLimitKey(request: RateLimitRequest): string {
  const body =
    request.body && typeof request.body === "object"
      ? (request.body as Record<string, unknown>)
      : null;
  const actorId = body?.actorId;
  if (
    typeof actorId === "string" &&
    actorId.length >= 1 &&
    actorId.length <= 100
  ) {
    return `ws-ticket:actor:${actorId}`;
  }
  return `ws-ticket:ip:${request.ip}`;
}

/**
 * Fixed-window counter used as a per-IP FLOOR beneath actor-keyed limiters.
 * `ticketRateLimitKey` keys on the caller-chosen actorId, so a client rotating
 * actor ids gets a fresh bucket per request; this counter caps the source IP
 * regardless of what the body claims. Returns true while the call is allowed.
 */
export function createFixedWindowIpLimiter(
  max: number,
  windowMs: number,
  now: () => number = Date.now,
): (ip: string) => boolean {
  const windows = new Map<string, { resetAt: number; count: number }>();
  return (ip: string) => {
    const currentTime = now();
    const window = windows.get(ip);
    if (!window || window.resetAt <= currentTime) {
      // Opportunistic sweep so long-gone IPs cannot grow the map forever.
      if (windows.size > 10_000) {
        for (const [key, value] of windows) {
          if (value.resetAt <= currentTime) windows.delete(key);
        }
      }
      windows.set(ip, { resetAt: currentTime + windowMs, count: 1 });
      return true;
    }
    window.count += 1;
    return window.count <= max;
  };
}

/** Preserve safe client statuses instead of rewriting them as HTTP 500. */
export function clientErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode < 500
    ? statusCode
    : null;
}
