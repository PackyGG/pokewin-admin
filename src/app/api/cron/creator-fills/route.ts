import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { dispatchWebhook } from "@/lib/webhook-dispatcher";

export async function GET(request: Request) {
  // Verify cron secret (Vercel sets Authorization header for cron jobs)
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  // Find all active deals with daily fill enabled
  // Runs once per day via Vercel Cron (Hobby: daily, ±59min precision)
  const deals = await adminDb.creator_deals.findMany({
    where: {
      daily_fill_enabled: true,
      daily_fill_amount: { not: null },
      status: "active",
    },
  });

  const results: { userId: string; amount: number; status: string }[] = [];

  for (const deal of deals) {
    // Check if already filled today for this deal (idempotent)
    const existingFill = await adminDb.creator_balance_fills.findFirst({
      where: {
        target_user_id: deal.target_user_id,
        deal_id: deal.id,
        created_at: { gte: todayStart },
      },
    });

    if (existingFill) continue;

    const amount = Number(deal.daily_fill_amount);
    if (amount <= 0) continue;

    try {
      // Add balance to user
      await db.balances.update({
        where: { user_id: deal.target_user_id },
        data: { available_balance: { increment: amount } },
      });

      // Record the fill
      const fill = await adminDb.creator_balance_fills.create({
        data: {
          target_user_id: deal.target_user_id,
          deal_id: deal.id,
          amount,
          status: "completed",
          triggered_by: "cron",
        },
      });

      // Dispatch webhook
      try {
        const webhookResult = await dispatchWebhook(deal.target_user_id, "balance_fill", {
          fillId: fill.id,
          userId: deal.target_user_id,
          amount,
          dealId: deal.id,
          dealName: deal.deal_name,
          triggeredBy: "cron",
        });
        if (webhookResult.sent > 0) {
          await adminDb.creator_balance_fills.update({
            where: { id: fill.id },
            data: { webhook_sent: true },
          });
        }
      } catch {
        // Webhook failure should not block the fill
      }

      results.push({ userId: deal.target_user_id, amount, status: "completed" });
    } catch (error) {
      // Record failed fill
      await adminDb.creator_balance_fills.create({
        data: {
          target_user_id: deal.target_user_id,
          deal_id: deal.id,
          amount,
          status: "failed",
          triggered_by: "cron",
          webhook_error: error instanceof Error ? error.message : "Unknown error",
        },
      });

      results.push({ userId: deal.target_user_id, amount, status: "failed" });
    }
  }

  return NextResponse.json({
    processed: results.length,
    results,
    timestamp: now.toISOString(),
  });
}
