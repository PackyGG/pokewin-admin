import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { dispatchWebhook } from "@/lib/webhook-dispatcher";
import { toNumber } from "@/lib/utils/decimal";

function isAuthorizedCron(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization");
  if (!header) return false;
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: Request) {
  const db = await getDb();
  // Verify cron secret (Vercel sets Authorization header for cron jobs).
  // Use timingSafeEqual to avoid leaking length/prefix via timing side-channel.
  if (!isAuthorizedCron(request)) {
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
      // Wrap the main DB writes (balance update + paired ledger entry)
      // in an interactive transaction so they land atomically. The admin
      // DB write (creator_balance_fills) happens after commit because
      // cross-DB transactions aren't supported — on admin-side failure the
      // user still has the money + audit trail via ledger_transactions.
      await db.$transaction(async (tx) => {
        const balance = await tx.balances.findUnique({
          where: { user_id: deal.target_user_id },
          select: { available_balance: true },
        });
        if (!balance) {
          throw new Error(`User balance not found for ${deal.target_user_id}`);
        }
        const balanceBefore = toNumber(balance.available_balance);
        const balanceAfter = balanceBefore + amount;

        await tx.balances.update({
          where: { user_id: deal.target_user_id },
          data: { available_balance: balanceAfter },
        });

        await tx.ledger_transactions.create({
          data: {
            user_id: deal.target_user_id,
            type: "admin_balance_adjustment",
            amount,
            balance_before: balanceBefore,
            balance_after: balanceAfter,
            description: `Daily creator fill — deal ${deal.deal_name}`,
            status: "completed",
          },
        });
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
