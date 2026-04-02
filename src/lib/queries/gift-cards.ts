import { db } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";

export type GiftCardListItem = {
  id: string;
  value: number;
  region: string;
  code: string | null;
  status: "available" | "redeemed" | "cancelled" | "expired";
  createdByAdminId: string | null;
  createdByUsername: string | null;
  redeemedByUsername: string | null;
  cancelledAt: string | null;
  cancelledByAdminId: string | null;
  cancelledByUsername: string | null;
  redeemedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
};

export async function getGiftCards(params: {
  page?: number;
  perPage?: number;
  status?: string;
  region?: string;
  search?: string;
}): Promise<PaginatedResult<GiftCardListItem>> {
  const { page = 1, perPage = 20, status, region, search } = params;

  const where: Record<string, unknown> = {};

  if (status === "redeemed") {
    where.redeemed_at = { not: null };
  } else if (status === "available") {
    where.redeemed_at = null;
    where.OR = [{ expires_at: null }, { expires_at: { gte: new Date() } }];
  } else if (status === "expired") {
    where.redeemed_at = null;
    where.expires_at = { lt: new Date() };
  }
  // cancelled is filtered post-query via admin actions

  if (region) {
    where.region = region;
  }

  if (search) {
    where.code = { contains: search, mode: "insensitive" };
  }

  const [cards, total] = await Promise.all([
    db.gift_cards.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        user: { select: { username: true } },
      },
    }),
    db.gift_cards.count({ where }),
  ]);

  // Batch-fetch admin actions for these gift cards
  const cardIds = cards.map((c) => c.id);
  const adminActions = cardIds.length > 0
    ? await adminDb.admin_gift_card_actions.findMany({
        where: { gift_card_id: { in: cardIds } },
        include: { admin_user: { select: { id: true, username: true } } },
      })
    : [];

  const actionsByCardId = new Map<string, typeof adminActions>();
  for (const a of adminActions) {
    const list = actionsByCardId.get(a.gift_card_id) ?? [];
    list.push(a);
    actionsByCardId.set(a.gift_card_id, list);
  }

  function getStatus(c: (typeof cards)[number]): GiftCardListItem["status"] {
    const actions = actionsByCardId.get(c.id) ?? [];
    if (actions.some((a) => a.action === "cancelled")) return "cancelled";
    if (c.redeemed_at) return "redeemed";
    if (c.expires_at && c.expires_at < new Date()) return "expired";
    return "available";
  }

  const mapped = cards.map((c) => {
    const actions = actionsByCardId.get(c.id) ?? [];
    const cancelAction = actions.find((a) => a.action === "cancelled");
    const createAction = actions.find((a) => a.action === "created");

    return {
      id: c.id,
      value: toNumber(c.value),
      region: c.region,
      code: c.code,
      status: getStatus(c),
      createdByAdminId: createAction?.admin_user.id ?? null,
      createdByUsername: createAction?.admin_user.username ?? null,
      redeemedByUsername: c.user?.username ?? null,
      cancelledAt: cancelAction?.created_at.toISOString() ?? null,
      cancelledByAdminId: cancelAction?.admin_user.id ?? null,
      cancelledByUsername: cancelAction?.admin_user.username ?? null,
      redeemedAt: c.redeemed_at?.toISOString() ?? null,
      expiresAt: c.expires_at?.toISOString() ?? null,
      createdAt: c.created_at.toISOString(),
    };
  });

  // If filtering by cancelled status, we need to handle it differently
  // since it's stored in admin DB. For now, filter post-query.
  const filtered = status === "cancelled"
    ? mapped.filter((c) => c.status === "cancelled")
    : status
      ? mapped.filter((c) => c.status === status)
      : mapped;

  return {
    data: filtered,
    total: status === "cancelled" ? filtered.length : total,
    page,
    perPage,
    totalPages: Math.ceil((status === "cancelled" ? filtered.length : total) / perPage),
  };
}
