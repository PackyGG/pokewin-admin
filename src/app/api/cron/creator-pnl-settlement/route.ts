import { NextResponse } from "next/server";

import { mapPool } from "@/app/(creator-hub)/creator-hub/_lib/backend-walk";
import {
  listDueCreatorPnlDeals,
  settleCreatorPnlDeal,
} from "@/lib/creator-pnl-settlement";
import { constantTimeEqual } from "@/lib/security/constant-time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BATCH_LIMIT = 20;
const CONCURRENCY = 2;

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (secret) {
    if (!constantTimeEqual(request.headers.get("authorization"), `Bearer ${secret}`)) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  } else if (process.env.NODE_ENV === "production") {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const queue = await listDueCreatorPnlDeals(BATCH_LIMIT);
  const results = await mapPool(queue.data, CONCURRENCY, async (deal) => {
    try {
      const result = await settleCreatorPnlDeal({
        userId: deal.user_id,
        dealId: deal.id,
        expectedVersion: deal.version,
      });
      return {
        dealId: deal.id,
        userId: deal.user_id,
        status: "settled" as const,
        frameSitePnlUsd: result.breakdown.frame_site_pnl_usd,
        creatorShareUsd: Number(result.deal.creator_share_usd ?? 0),
      };
    } catch (error) {
      return {
        dealId: deal.id,
        userId: deal.user_id,
        status: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  return NextResponse.json({
    ok: results.every((result) => result.status === "settled"),
    queued: queue.data.length,
    remaining: Math.max(0, queue.total - queue.data.length),
    settled: results.filter((result) => result.status === "settled").length,
    failed: results.filter((result) => result.status === "failed").length,
    results,
  });
}
