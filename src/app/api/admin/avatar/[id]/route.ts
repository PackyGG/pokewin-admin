import { NextResponse } from "next/server";
import { adminDb } from "@/lib/admin-db";
import { verifySession } from "@/lib/dal";

// UUID v4-ish validation — protects against SQL-probe ids being passed through.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Serves the raw avatar bytes for an admin user. Only authenticated admins
 * can fetch. Returns 404 when the admin has no avatar or the profile
 * columns don't exist yet (pre-migration).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  // verifySession redirects on failure — but redirect is meaningless for an
  // image endpoint, so we manually short-circuit with 401 here.
  // (verifySession returns SessionPayload on success.)
  try {
    await verifySession();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  let row: { profile_image: Uint8Array | null; profile_image_mime: string | null } | null;
  try {
    row = await adminDb.admin_users.findUnique({
      where: { id },
      select: { profile_image: true, profile_image_mime: true },
    });
  } catch (err) {
    // Pre-migration: columns missing → treat as "no avatar".
    const code = (err as { code?: string })?.code;
    if (code === "P2022" || (err instanceof Error && /column .* does not exist/i.test(err.message))) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw err;
  }

  if (!row || !row.profile_image || !row.profile_image_mime) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Prisma returns Bytes as a Uint8Array. Copy into a fresh ArrayBuffer so
  // we can hand it straight to NextResponse without BodyInit type friction.
  const src = row.profile_image;
  const body = new Uint8Array(new ArrayBuffer(src.length));
  body.set(src);

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": row.profile_image_mime,
      // Short cache — admins can update their avatar anytime.
      "Cache-Control": "private, max-age=60",
    },
  });
}
