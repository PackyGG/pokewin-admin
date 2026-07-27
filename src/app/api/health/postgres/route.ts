import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";

import { getProdReadDrizzleDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${secret}`) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const db = getProdReadDrizzleDb();
    await db.execute(sql`SELECT 1`);
    return NextResponse.json({
      ok: true,
      reachable: true,
      latencyMs: Date.now() - startedAt,
      serving: "postgres",
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        reachable: false,
        latencyMs: Date.now() - startedAt,
        serving: "postgres",
        error: error instanceof Error ? error.name : "DatabaseError",
      },
      { status: 503 },
    );
  }
}
