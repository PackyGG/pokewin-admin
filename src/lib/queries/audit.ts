import { adminDb } from "@/lib/admin-db";
import { db } from "@/lib/db";
import type { PaginatedResult } from "@/lib/types";

export type AuditListItem = {
  id: string;
  eventType: string;
  adminUserId: string | null;
  adminUsername: string | null;
  targetUserId: string | null;
  targetUsername: string | null;
  ip: string | null;
  metadata: unknown;
  messageContent: string | null;
  messageDeleted: boolean | null;
  promoCodeId: string | null;
  createdAt: string;
};

export async function getAuditEvents(params: {
  page?: number;
  perPage?: number;
  search?: string;
  eventType?: string;
  targetUserId?: string;
}): Promise<PaginatedResult<AuditListItem>> {
  const { page = 1, perPage = 20, search, eventType, targetUserId } = params;

  const where: Record<string, unknown> = {};

  if (search) {
    where.OR = [
      { admin_user_id: search },
      { target_user_id: search },
      { ip: search },
      { admin_user: { username: { contains: search, mode: "insensitive" } } },
    ];
  }

  if (eventType && eventType !== "all") {
    where.event_type = eventType;
  }

  if (targetUserId) {
    where.target_user_id = targetUserId;
  }

  const [events, total] = await Promise.all([
    adminDb.admin_audit_events.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        admin_user: { select: { username: true } },
      },
    }),
    adminDb.admin_audit_events.count({ where }),
  ]);

  // Build ID lists from the event batch first (pure in-memory work) then
  // hit the three independent lookup tables in one Promise.all round-trip.
  const targetUserIds = [...new Set(events.map((e) => e.target_user_id).filter(Boolean))] as string[];
  const codeHashes = events
    .map((e) => (e.metadata as Record<string, unknown>)?.code_hash)
    .filter((h): h is string => typeof h === "string");
  const uniqueCodeHashes = [...new Set(codeHashes)];
  const messageIds = events
    .map((e) => (e.metadata as Record<string, unknown>)?.message_id)
    .filter((id): id is string => typeof id === "string");
  const uniqueMessageIds = [...new Set(messageIds)];

  const [targetUsers, promoCodes, messages] = await Promise.all([
    targetUserIds.length > 0
      ? db.user.findMany({
          where: { id: { in: targetUserIds } },
          select: { id: true, username: true },
        })
      : Promise.resolve([] as Array<{ id: string; username: string | null }>),
    uniqueCodeHashes.length > 0
      ? db.promo_codes.findMany({
          where: { code_hash: { in: uniqueCodeHashes } },
          select: { id: true, code_hash: true },
        })
      : Promise.resolve([] as Array<{ id: string; code_hash: string }>),
    uniqueMessageIds.length > 0
      ? db.chat_messages.findMany({
          where: { id: { in: uniqueMessageIds } },
          select: { id: true, content: true, is_deleted: true },
        })
      : Promise.resolve([] as Array<{ id: string; content: string; is_deleted: boolean }>),
  ]);

  const targetUserMap = new Map(targetUsers.map((u) => [u.id, u.username]));
  const promoCodeMap = new Map(promoCodes.map((p) => [p.code_hash, p.id]));
  const messageMap = new Map(messages.map((m) => [m.id, m]));

  return {
    data: events.map((e) => {
      const meta = e.metadata as Record<string, unknown> | null;
      const msgId = meta?.message_id as string | undefined;
      const msg = msgId ? messageMap.get(msgId) ?? null : null;
      const codeHash = meta?.code_hash as string | undefined;
      const promoId = codeHash ? promoCodeMap.get(codeHash) ?? null : null;

      return {
        id: e.id,
        eventType: e.event_type,
        adminUserId: e.admin_user_id,
        adminUsername: e.admin_user?.username ?? null,
        targetUserId: e.target_user_id,
        targetUsername: e.target_user_id ? targetUserMap.get(e.target_user_id) ?? null : null,
        ip: e.ip,
        metadata: e.metadata,
        messageContent: msg?.content ?? null,
        messageDeleted: msg?.is_deleted ?? null,
        promoCodeId: promoId,
        createdAt: e.created_at.toISOString(),
      };
    }),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
