import { withApiKey } from "@/lib/api-auth/with-api-key";

/**
 * GET /api/v1/whoami — credential self-check.
 *
 * Requires a valid key but NO specific scope, so a consumer (the Discord bot,
 * a deploy smoke test) can verify its token works and see exactly what it is
 * allowed to do before calling anything real. Returns only data the caller
 * already possesses — never any platform data.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApiKey({ scopes: [] }, async (_request, { principal }) => ({
  keyId: principal.keyId,
  name: principal.name,
  prefix: principal.prefix,
  scopes: principal.scopes,
}));
