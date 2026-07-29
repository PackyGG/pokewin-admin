import { NextResponse } from "next/server";
import ImageKit from "imagekit";
import { requirePageAccess } from "@/lib/dal";

// Force dynamic — the handler reads env vars + checks session, so static
// evaluation isn't possible. Without this flag Next 15 Turbopack tries to
// evaluate the route at build-time during "Collecting page data", and a
// module-scope `new ImageKit({...})` would throw "Missing privateKey"
// if the env var isn't wired into the build-time environment.
export const dynamic = "force-dynamic";

/**
 * Lazy singleton — only instantiates on first actual request. Keeps the
 * build step free of side-effects and makes this route tolerant of the
 * env var being missing at build time (it'll throw on first call instead,
 * which surfaces as a clean 500 for that endpoint only).
 */
let imagekitClient: ImageKit | null = null;
function getClient(): ImageKit {
  if (imagekitClient) return imagekitClient;
  const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error(
      "IMAGEKIT_PRIVATE_KEY is not configured on this deployment",
    );
  }
  imagekitClient = new ImageKit({
    publicKey: "public_lS39S3O5jxxdHwDOfOON7HM/cBA=",
    privateKey,
    urlEndpoint: "https://ik.imagekit.io/scrkflpgw",
  });
  return imagekitClient;
}

export async function GET() {
  // requirePageAccess redirect()s on failure — this endpoint is consumed
  // via fetch() by the upload widget, so an expired session would get a
  // 307-to-login HTML page instead of a parseable error. Short-circuit
  // with 401 JSON (same pattern as api/admin/avatar/[id]).
  try {
    await requirePageAccess("/packs");
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const authParams = getClient().getAuthenticationParameters();
  return NextResponse.json(authParams);
}
