import { NextResponse } from "next/server";

import { runRainAbuseDetection } from "@/lib/antifraud/reward-abuse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (!secret && process.env.NODE_ENV === "production") {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const result = await runRainAbuseDetection();
  return NextResponse.json({ ok: true, ...result });
}
