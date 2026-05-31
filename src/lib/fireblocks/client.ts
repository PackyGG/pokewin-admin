import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";

/**
 * Minimal Fireblocks REST client.
 *
 * Read-only. Signs each request with an RS256 JWT per Fireblocks' API
 * spec (https://developers.fireblocks.com/reference/api-overview):
 *
 *   - `uri`      → the request path WITH query string (e.g. /v1/vault/assets)
 *   - `nonce`    → fresh UUID per request, never reused for the same key
 *   - `iat`      → seconds since epoch (now)
 *   - `exp`      → iat + 30s (Fireblocks max is 55s; 30s is safe)
 *   - `sub`      → the API key UUID (FIREBLOCKS_API_KEY)
 *   - `bodyHash` → SHA-256 hex of the request body — REQUIRED EVEN FOR
 *                  GET, where the body is the empty string ("")
 *
 * Headers per request:
 *   X-API-Key:     <uuid>
 *   Authorization: Bearer <jwt>
 *   Content-Type:  application/json
 *
 * Production base URL only: `https://api.fireblocks.io`.
 *
 * Secrets are read from process.env. Neither the API key nor the private
 * key is ever logged. Errors surface the HTTP status + endpoint path only.
 */

const FIREBLOCKS_BASE = "https://api.fireblocks.io";

/**
 * Thrown when the Fireblocks API responds with a non-2xx, OR when env
 * vars are missing. The message intentionally never contains the
 * response body — Fireblocks error payloads can echo back parts of the
 * request that we don't want sitting in our log aggregator.
 */
export class FireblocksError extends Error {
  readonly status: number;
  readonly endpoint: string;
  constructor(status: number, endpoint: string, summary: string) {
    super(`Fireblocks ${endpoint} → ${status} ${summary}`);
    this.name = "FireblocksError";
    this.status = status;
    this.endpoint = endpoint;
  }
}

export function fireblocksConfigured(): boolean {
  return Boolean(
    process.env.FIREBLOCKS_API_KEY && process.env.FIREBLOCKS_API_SECRET,
  );
}

function readEnv(): { apiKey: string; apiSecret: string } {
  const apiKey = process.env.FIREBLOCKS_API_KEY;
  const apiSecret = process.env.FIREBLOCKS_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new FireblocksError(
      0,
      "config",
      "FIREBLOCKS_API_KEY / FIREBLOCKS_API_SECRET not set",
    );
  }
  return { apiKey, apiSecret };
}

/**
 * Cache the imported PKCS8 private key across calls within a single
 * server instance. importPKCS8 parses the PEM each time; reusing the
 * KeyLike makes subsequent JWT signings cheap.
 *
 * Keyed by the secret string itself so that if the env var is rotated
 * (e.g. via a Vercel deploy with new secrets) the cache is naturally
 * invalidated — the new secret string is a fresh map key.
 */
const keyCache = new Map<string, Promise<CryptoKey | Uint8Array>>();

async function getSigningKey(
  apiSecret: string,
): Promise<CryptoKey | Uint8Array> {
  let cached = keyCache.get(apiSecret);
  if (!cached) {
    cached = importPKCS8(apiSecret, "RS256");
    keyCache.set(apiSecret, cached);
  }
  return cached;
}

function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Build a Fireblocks-spec JWT for a single request. `path` MUST be the
 * pathname + querystring of the request (no scheme, no host). For GETs
 * with no body, pass `body = ""` — Fireblocks still requires the
 * SHA-256 of the empty string in the `bodyHash` claim.
 */
async function buildJwt(params: {
  apiKey: string;
  apiSecret: string;
  path: string;
  body: string;
}): Promise<string> {
  const { apiKey, apiSecret, path, body } = params;
  const now = Math.floor(Date.now() / 1000);
  const key = await getSigningKey(apiSecret);
  return await new SignJWT({
    uri: path,
    nonce: randomUUID(),
    iat: now,
    exp: now + 30,
    sub: apiKey,
    bodyHash: sha256Hex(body),
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .sign(key);
}

/**
 * Issue a signed GET against Fireblocks and decode the JSON response.
 * Read-only by design — this client intentionally does not expose POST,
 * PUT, or DELETE. If a future caller needs to call a write endpoint
 * they must add a separate, carefully audited helper.
 *
 * `path` must start with "/" (e.g. "/v1/vault/assets"). The full URL is
 * built from the production base; the same `path` value is signed into
 * the `uri` JWT claim, which is exactly what Fireblocks verifies.
 */
export async function fireblocksGet<T>(path: string): Promise<T> {
  const { apiKey, apiSecret } = readEnv();
  if (!path.startsWith("/")) {
    throw new FireblocksError(0, path, "path must start with /");
  }

  const jwt = await buildJwt({ apiKey, apiSecret, path, body: "" });

  let res: Response;
  try {
    res = await fetch(`${FIREBLOCKS_BASE}${path}`, {
      method: "GET",
      headers: {
        "X-API-Key": apiKey,
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json",
      },
      // Cache layer is owned by the caller (unstable_cache); the
      // underlying fetch must NOT cache, otherwise the per-request JWT
      // gets stuck in Next's fetch cache and replays a long-expired
      // token to Fireblocks.
      cache: "no-store",
    });
  } catch {
    // Network-level failure (DNS, TLS, connection refused). Surface as
    // a 0-status error with no upstream message — Node's fetch error
    // strings can include the URL but not credentials.
    throw new FireblocksError(0, path, "network error");
  }

  if (!res.ok) {
    // Drain the body so the socket can be reused, but DO NOT include it
    // in the error. Fireblocks 4xx payloads can echo back request
    // fragments we don't want in logs.
    try {
      await res.text();
    } catch {
      /* ignore */
    }
    throw new FireblocksError(res.status, path, res.statusText || "request failed");
  }

  return (await res.json()) as T;
}
