import "server-only";

import { eq, sql } from "drizzle-orm";
import { after } from "next/server";

import { adminDrizzle } from "@/lib/admin-db";
import { admin_audit_events, api_keys } from "@/lib/db-schema/admin/schema";
import { isIpAllowed, resolveClientIp } from "./ip";
import { checkApiRateLimit, type ApiRateLimitResult } from "./rate-limit";
import { missingScopes, toApiScopes, type ApiScope } from "./scopes";
import { parseTokenPrefix, safeEqualHex, sha256Hex } from "./token";

/**
 * Bearer-token authentication for the `/api/v1/*` surface.
 *
 * DESIGN NOTES (why it's shaped this way):
 *
 *  • DENY BY DEFAULT. Every exit path that isn't a fully-verified, in-scope,
 *    under-limit key returns a failure. There is no "allow if unsure" branch.
 *
 *  • NO ENUMERATION. Unknown prefix, wrong secret, disabled, revoked and
 *    expired all return the SAME opaque 401 (`invalid_api_key`). A caller
 *    cannot use the response to learn whether a prefix exists or why it
 *    failed. Only scope (403) and rate limit (429) are distinguishable —
 *    those require a valid key, so they leak nothing to an attacker.
 *
 *  • CONSTANT-TIME. The secret compare is `timingSafeEqual` over hex digests.
 *
 *  • HEADER ONLY. The token must arrive in `Authorization: Bearer …`. We never
 *    read it from a query string or cookie: query strings land in access logs,
 *    proxies and browser history, and a cookie would make the surface
 *    CSRF-reachable from a browser context.
 *
 *  • FAILURES ARE AUDITED (best-effort, out of band via `after()`), so a
 *    credential-stuffing attempt is visible in /audit rather than silent.
 */

export type ApiPrincipal = {
  keyId: string;
  name: string;
  prefix: string;
  scopes: ApiScope[];
};

type ApiAuthFailure = {
  ok: false;
  status: 401 | 403 | 429;
  code:
    | "invalid_api_key"
    | "insufficient_scope"
    | "ip_not_allowed"
    | "rate_limited";
  message: string;
  /** Present only for 429 so the handler can emit Retry-After. */
  rateLimit?: ApiRateLimitResult;
};

type ApiAuthSuccess = {
  ok: true;
  principal: ApiPrincipal;
  rateLimit: ApiRateLimitResult;
};

export type ApiAuthResult = ApiAuthSuccess | ApiAuthFailure;

/** One opaque failure for every credential problem — see NO ENUMERATION above. */
const INVALID: ApiAuthFailure = {
  ok: false,
  status: 401,
  code: "invalid_api_key",
  message: "Invalid or missing API key.",
};

/**
 * Client IP, resolved from the most-trustworthy proxy header available.
 * Re-exported for callers that already imported it from here.
 */
function clientIpFrom(request: Request): string | null {
  return resolveClientIp(request);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  // Case-insensitive scheme, exactly one space, non-empty credential.
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

function auditAuthFailure(reason: string, request: Request, prefix: string | null) {
  const ip = clientIpFrom(request);
  const path = new URL(request.url).pathname;
  // Written directly (not via createAdminAuditEvent) because that helper
  // requires an admin_user_id and an unauthenticated caller has none — the
  // column itself is nullable. Never awaited on the request path, and never
  // allowed to throw.
  after(() => {
    adminDrizzle
      .insert(admin_audit_events)
      .values({
        admin_user_id: null,
        event_type: "api_key_auth_failed",
        ip,
        // `prefix` is PUBLIC (not secret) and is what makes a failure
        // actionable. The token itself is NEVER logged.
        metadata: { reason, prefix, path },
      })
      .catch(() => {});
  });
}

/**
 * Authenticate a request and assert it holds every scope in `required`.
 * Returns a discriminated result; the caller must not proceed on `ok: false`.
 */
export async function authenticateApiRequest(
  request: Request,
  required: readonly ApiScope[],
): Promise<ApiAuthResult> {
  const token = bearerToken(request);
  if (!token) {
    auditAuthFailure("missing_bearer", request, null);
    return INVALID;
  }

  const prefix = parseTokenPrefix(token);
  if (!prefix) {
    auditAuthFailure("malformed_token", request, null);
    return INVALID;
  }

  const [row] = await adminDrizzle
    .select({
      id: api_keys.id,
      name: api_keys.name,
      prefix: api_keys.prefix,
      key_hash: api_keys.key_hash,
      scopes: api_keys.scopes,
      allowed_ips: api_keys.allowed_ips,
      is_active: api_keys.is_active,
      expires_at: api_keys.expires_at,
      revoked_at: api_keys.revoked_at,
      rate_limit_per_min: api_keys.rate_limit_per_min,
    })
    .from(api_keys)
    .where(eq(api_keys.prefix, prefix))
    .limit(1);

  // Hash the presented token regardless of whether the row exists, then
  // compare against a dummy when it doesn't — keeps the work (and therefore
  // the timing) similar for "unknown prefix" vs "wrong secret".
  const presentedHash = sha256Hex(token);
  const storedHash = row?.key_hash ?? "0".repeat(64);
  const secretMatches = safeEqualHex(presentedHash, storedHash);

  if (!row || !secretMatches) {
    auditAuthFailure(row ? "bad_secret" : "unknown_prefix", request, prefix);
    return INVALID;
  }

  if (!row.is_active || row.revoked_at !== null) {
    auditAuthFailure("revoked_or_disabled", request, prefix);
    return INVALID;
  }

  if (
    row.expires_at !== null &&
    new Date(row.expires_at).getTime() <= Date.now()
  ) {
    auditAuthFailure("expired", request, prefix);
    return INVALID;
  }

  const scopes = toApiScopes(row.scopes);
  // `missingScopes` short-circuits on the wildcard grant, so a full-access key
  // passes every check — including endpoints that don't exist yet.
  const missing = missingScopes(scopes, required);
  if (missing.length > 0) {
    auditAuthFailure("insufficient_scope", request, prefix);
    return {
      ok: false,
      status: 403,
      code: "insufficient_scope",
      message: `Missing required scope(s): ${missing.join(", ")}.`,
    };
  }

  // IP allowlist — checked AFTER the secret so an attacker without a valid
  // token learns nothing about it. Empty list = unrestricted; a configured
  // list with an unresolvable IP fails CLOSED (see isIpAllowed).
  const ip = resolveClientIp(request);
  if (!isIpAllowed(ip, row.allowed_ips)) {
    auditAuthFailure("ip_not_allowed", request, prefix);
    return {
      ok: false,
      status: 403,
      code: "ip_not_allowed",
      message: "This API key is not permitted from your IP address.",
    };
  }

  const rate = await checkApiRateLimit(row.id, row.rate_limit_per_min);
  if (!rate.allowed) {
    return {
      ok: false,
      status: 429,
      code: "rate_limited",
      message: "Rate limit exceeded.",
      rateLimit: rate,
    };
  }

  // Usage bookkeeping is best-effort and MUST NOT delay or fail the request.
  after(() => {
    adminDrizzle
      .update(api_keys)
      .set({
        last_used_at: new Date().toISOString(),
        last_used_ip: ip,
        request_count: sql`${api_keys.request_count} + 1`,
      })
      .where(eq(api_keys.id, row.id))
      .catch(() => {});
  });

  return {
    ok: true,
    principal: { keyId: row.id, name: row.name, prefix: row.prefix, scopes },
    rateLimit: rate,
  };
}
