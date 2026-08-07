import { timingSafeEqual } from "node:crypto";

import type { Config } from "./config.js";

export function safeTokenEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

/**
 * The ONLY mutating routes the widely-distributed read token may reach.
 *
 * Everything else that is not a safe method requires the admin token by
 * default, so a newly added `app.post`/`app.put` is admin-only until someone
 * deliberately lists it here. The previous shape enumerated the admin routes
 * instead, which meant an unlisted new write silently shipped writable with
 * the read token.
 *
 * `POST /v1/ws/tickets` mints a short-lived websocket ticket for an already
 * authenticated dashboard actor; it is a write only in the HTTP sense and the
 * dashboard holds the read token when it calls it.
 *
 * `POST /v1/fiat-eligibility/check` is deliberately absent: it never reaches
 * this function. The onRequest hook in server.ts authenticates it against the
 * per-environment FIAT_ELIGIBILITY_* API keys and returns before the bearer
 * check (server.ts, the `pathname === FIAT_ELIGIBILITY_PATH` branch).
 */
const READ_TOKEN_WRITES: ReadonlySet<string> = new Set(["POST /v1/ws/tickets"]);

const SAFE_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

export function serviceRequestAuthorized(
  method: string,
  pathname: string,
  token: string,
  config: Pick<Config, "API_TOKEN" | "API_ADMIN_TOKEN">,
): boolean {
  const isWrite = !SAFE_METHODS.has(method);
  const needsAdminToken =
    // Fail-closed default: every mutating route is admin-only unless it is on
    // the explicit read-token allowlist above.
    (isWrite && !READ_TOKEN_WRITES.has(`${method} ${pathname}`)) ||
    // Reads that expose admin-only detail. These stay enumerated because a
    // GET is presumed safe by default.
    //
    // Live transport observability names admin actor ids per connection; the
    // read token must not see them.
    (method === "GET" && pathname === "/v1/operations/live") ||
    (method === "GET" &&
      pathname.startsWith("/v1/kyc/applicants/") &&
      pathname.endsWith("/review")) ||
    (pathname === "/v1/operations/signup-failures" && method === "GET") ||
    (pathname.startsWith("/v1/testing/eos-random-block/config") && method === "GET") ||
    (method === "GET" &&
      pathname.startsWith("/v1/networks/") &&
      pathname.endsWith("/reveal"));
  return needsAdminToken
    ? safeTokenEqual(token, config.API_ADMIN_TOKEN)
    : safeTokenEqual(token, config.API_TOKEN) ||
      safeTokenEqual(token, config.API_ADMIN_TOKEN);
}
