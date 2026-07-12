import { NextResponse } from "next/server";
import { z } from "zod";
import { getPackEditPool } from "../../doctor/retune-actions";

/**
 * GET /pack-studio/retune/pool?packId=X — the workspace's READ-ONLY pool
 * transport.
 *
 * A route handler, deliberately NOT a server action, for the same reason the
 * plan route exists: React serializes server actions per client (one at a
 * time, in dispatch order), so one slow `planPackTune` server action queued
 * EVERY later pool/plan/pre-flight call behind it — the "card images/values
 * don't load after a push" and "next pack takes minutes" incident. Route
 * handlers run concurrently; `getPackEditPool` is a lightweight read-only
 * MAIN query (pack + cards PK probe), so it returns in well under a second
 * even while a plan solve is in-flight on a separate request.
 *
 * Auth runs INSIDE `getPackEditPool` (`requireRetuneOwner` — throws, never
 * redirects) exactly as it does for the action path; a denial surfaces as
 * 403 JSON.
 */

const querySchema = z.object({
  packId: z.string().min(1),
});

export const maxDuration = 30;

export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const parsed = querySchema.safeParse({
    packId: url.searchParams.get("packId"),
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid pool request." },
      { status: 400 },
    );
  }
  try {
    const pool = await getPackEditPool(parsed.data.packId);
    return NextResponse.json({ pool });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Pool fetch failed unexpectedly.";
    const status = /not authorized|restricted to authorized/i.test(message)
      ? 403
      : /invalid pack id/i.test(message)
        ? 400
        : /pack not found/i.test(message)
          ? 404
          : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
