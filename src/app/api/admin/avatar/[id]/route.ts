import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { adminDrizzle } from "@/lib/admin-db";
import { admin_users } from "@/lib/db-schema/admin/schema";
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

  let row:
    | { profile_image: Uint8Array | null; profile_image_mime: string | null }
    | undefined;
  try {
    [row] = await adminDrizzle
      .select({
        profile_image: admin_users.profile_image,
        profile_image_mime: admin_users.profile_image_mime,
      })
      .from(admin_users)
      .where(eq(admin_users.id, id))
      .limit(1);
  } catch (err) {
    // Pre-migration: columns missing → treat as "no avatar".
    const code = (err as { code?: string })?.code;
    if (
      code === "42703" ||
      (err instanceof Error && /column .* does not exist/i.test(err.message))
    ) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw err;
  }

  if (!row || !row.profile_image || !row.profile_image_mime) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // node-postgres returns bytea as a Buffer/Uint8Array. Copy it so
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
