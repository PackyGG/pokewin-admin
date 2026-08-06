import "server-only";

import { authenticateApiRequest, type ApiPrincipal } from "./authenticate";
import type { ApiRateLimitResult } from "./rate-limit";
import type { ApiScope } from "./scopes";

/**
 * The ONLY way to expose an endpoint on the `/api/v1/*` surface.
 *
 *   export const GET = withApiKey({ scopes: ["stats:read"] }, async (req, ctx) => {
 *     return { hello: ctx.principal.name };   // plain data → JSON 200
 *   });
 *
 * Guarantees for every wrapped handler:
 *  - Authenticated + scope-checked before the handler body runs (deny by default).
 *  - Per-key rate limiting, with RateLimit-* headers on every response.
 *  - Uniform error envelope `{ error: { code, message } }` — a thrown error
 *    becomes an opaque 500 and the stack is logged server-side ONLY. Internal
 *    messages, SQL and stack frames never reach the client.
 *  - `Cache-Control: no-store` + `nosniff` + `Vary: Authorization`, so an
 *    authenticated payload can never be cached by a proxy/CDN and served to
 *    a different (or unauthenticated) caller.
 *
 * DATA BOUNDARY (enforced by review, not by types): handlers here may READ the
 * prod game DB and WRITE ONLY the admin DB. Never write the prod game DB from
 * this surface — see `src/lib/api-auth/scopes.ts`.
 */

export type ApiHandlerContext<P = unknown> = {
  principal: ApiPrincipal;
  /** Route params for dynamic segments, already awaited. */
  params: P;
};

type Handler<P> = (
  request: Request,
  context: ApiHandlerContext<P>,
) => Promise<Response | unknown> | Response | unknown;

/** Next 15 passes `{ params: Promise<P> }` to route handlers. */
type RouteArgs<P> = { params: Promise<P> };

function baseHeaders(rate?: ApiRateLimitResult): Headers {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    // Authenticated data — never store it anywhere shared.
    "cache-control": "no-store, no-cache, must-revalidate, private",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    // The response body depends on WHICH key called — keep caches honest.
    vary: "Authorization",
  });
  if (rate) {
    headers.set("ratelimit-limit", String(rate.limit));
    headers.set("ratelimit-remaining", String(rate.remaining));
    headers.set("ratelimit-reset", String(rate.resetSeconds));
  }
  return headers;
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  rate?: ApiRateLimitResult,
): Response {
  const headers = baseHeaders(rate);
  if (status === 401) {
    // RFC 9110: tell a well-behaved client how to authenticate.
    headers.set("www-authenticate", 'Bearer realm="api", charset="UTF-8"');
  }
  if (status === 429 && rate) {
    headers.set("retry-after", String(rate.resetSeconds));
  }
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers,
  });
}

/**
 * Build an error response from inside a handler, in the SAME envelope the
 * wrapper uses for auth/scope/limit failures. Use this for validation errors
 * so every failure on this surface looks identical to a client.
 *
 * Keep `message` operator-safe: describe the SHAPE that was wrong, never echo
 * back internals (SQL, stack, row contents).
 *
 * RATE HEADERS: omitting `rate` is safe for the normal path — a Response
 * returned from a wrapped handler goes through the merge in `route()` below,
 * which backfills the per-KEY `RateLimit-*` from the authenticated state. What
 * that merge does NOT backfill is `Retry-After`, so a handler emitting its own
 * 429 (e.g. a per-subject limit) MUST pass its `rate` here or the client is
 * told to back off with no idea for how long.
 */
export function apiError(
  status: number,
  code: string,
  message: string,
  rate?: ApiRateLimitResult,
): Response {
  const headers = baseHeaders(rate);
  if (status === 429 && rate) {
    headers.set("retry-after", String(rate.resetSeconds));
  }
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers,
  });
}

export function withApiKey<P = Record<string, never>>(
  options: { scopes: readonly ApiScope[] },
  handler: Handler<P>,
) {
  return async function route(
    request: Request,
    args: RouteArgs<P>,
  ): Promise<Response> {
    let rate: ApiRateLimitResult | undefined;
    try {
      const auth = await authenticateApiRequest(request, options.scopes);
      if (!auth.ok) {
        return errorResponse(auth.status, auth.code, auth.message, auth.rateLimit);
      }
      rate = auth.rateLimit;

      const params = await args.params;
      const result = await handler(request, { principal: auth.principal, params });

      // A handler may return a Response directly (streaming, custom status);
      // otherwise we serialise whatever it returned as JSON 200.
      if (result instanceof Response) {
        const merged = new Headers(result.headers);
        baseHeaders(rate).forEach((value, key) => {
          if (!merged.has(key)) merged.set(key, value);
        });
        return new Response(result.body, {
          status: result.status,
          statusText: result.statusText,
          headers: merged,
        });
      }

      return new Response(JSON.stringify({ data: result ?? null }), {
        status: 200,
        headers: baseHeaders(rate),
      });
    } catch (err) {
      // Server-side only. The client gets nothing but an opaque code.
      console.error("[api/v1] unhandled handler error:", err);
      return errorResponse(
        500,
        "internal_error",
        "An unexpected error occurred.",
        rate,
      );
    }
  };
}
