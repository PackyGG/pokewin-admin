import "server-only";

import { adminDb } from "@/lib/admin-db";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

/**
 * Per-card data for the /marketing/giveaway feed. One row per
 * `admin_giveaway_actions` entry, enriched with:
 *   • the admin's username (admin DB join — cheap)
 *   • the recipient user's username + image (main DB lookup —
 *     batched across the page so it's one round-trip not N).
 */
export type GiveawayCard = {
  id: string;
  amountUsd: number;
  sourceUrl: string;
  sourceType: "twitter" | "discord" | "other";
  reason: string | null;
  ledgerTxId: string | null;
  createdAt: string;
  recipient: {
    userId: string;
    username: string | null;
    image: string | null;
  };
  admin: {
    username: string;
  };
};

export async function getGiveawayFeed(params?: {
  limit?: number;
}): Promise<GiveawayCard[]> {
  const limit = Math.max(1, Math.min(500, Math.floor(params?.limit ?? 200)));

  const rows = await adminDb.admin_giveaway_actions.findMany({
    orderBy: { created_at: "desc" },
    take: limit,
    include: {
      admin_user: { select: { username: true } },
    },
  });

  // Resolve recipient usernames in ONE main-DB call instead of N
  // (one per card). Some recipients may no longer exist (account
  // deleted post-giveaway) → fall back to a clipped ID so the row
  // still renders.
  const recipientIds = [...new Set(rows.map((r) => r.target_user_id))];
  const recipientById = new Map<
    string,
    { username: string | null; image: string | null }
  >();
  if (recipientIds.length > 0) {
    const db = await getDb();
    const users = await db.user.findMany({
      where: { id: { in: recipientIds } },
      select: { id: true, username: true, image: true },
    });
    for (const u of users) {
      recipientById.set(u.id, {
        username: u.username,
        image: u.image,
      });
    }
  }

  return rows.map((r) => {
    const recipient = recipientById.get(r.target_user_id) ?? {
      username: null,
      image: null,
    };
    return {
      id: r.id,
      amountUsd: toNumber(r.amount_usd),
      sourceUrl: r.source_url,
      // Narrow the persisted string to the union the UI expects.
      // Unknown values fall to "other" so an out-of-band schema
      // change can't crash the card render.
      sourceType:
        r.source_type === "twitter" || r.source_type === "discord"
          ? r.source_type
          : "other",
      reason: r.reason,
      ledgerTxId: r.ledger_tx_id,
      createdAt: r.created_at.toISOString(),
      recipient: {
        userId: r.target_user_id,
        username: recipient.username,
        image: recipient.image,
      },
      admin: { username: r.admin_user?.username ?? "(unknown)" },
    };
  });
}

/**
 * Top-line totals for the page header (count + USD given away).
 */
export async function getGiveawayTotals(): Promise<{
  count: number;
  totalUsd: number;
}> {
  const agg = await adminDb.admin_giveaway_actions.aggregate({
    _count: true,
    _sum: { amount_usd: true },
  });
  return {
    count: agg._count ?? 0,
    totalUsd: toNumber(agg._sum.amount_usd),
  };
}
