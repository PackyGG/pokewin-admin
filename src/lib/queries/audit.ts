import { adminDb } from "@/lib/admin-db";
import { getDb } from "@/lib/db";
import type { PaginatedResult } from "@/lib/types";
import { isUuid } from "@/lib/utils/ids";
import { withTimeout, isQueryTimeoutError } from "@/lib/errors/safe-query";
import { logError } from "@/lib/errors/logger";

// Wall-clock budget for the cross-DB main-DB side of the audit search
// (username→id resolution + target-user/promo/message hydration). These
// are bounded, indexed lookups that finish in well under a second on
// prod-sized data; the timeout only fires if the main DB is genuinely
// slow/unavailable, in which case the page degrades to events with raw
// ids rather than digesting the whole /audit route. Kept short because
// none of these are heavy aggregates — they're point lookups by id.
const AUDIT_MAIN_DB_TIMEOUT_MS = 8_000;

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

/**
 * Count of DISTINCT event_type values actually present in the audit table.
 * The /audit "Event Types" KPI used to display a hardcoded array length,
 * which presented a constant as if it were data on an audit surface. This
 * returns the real cardinality so the tile reflects the DB. Cheap: a single
 * grouped scan over a free String column (covered by the event_type index).
 */
export async function getDistinctEventTypeCount(): Promise<number> {
  const rows = await adminDb.admin_audit_events.groupBy({
    by: ["event_type"],
  });
  return rows.length;
}

export async function getAuditEvents(params: {
  page?: number;
  perPage?: number;
  search?: string;
  eventType?: string;
  targetUserId?: string;
}): Promise<PaginatedResult<AuditListItem>> {
  const db = await getDb();
  const { page = 1, perPage = 20, search, eventType, targetUserId } = params;

  const where: Record<string, unknown> = {};

  if (search) {
    // target_user_id lives in the admin DB but the username it points at
    // lives in the main DB (no cross-DB join), so resolve search → matching
    // main-DB user ids first and fold them into the OR. This makes the most
    // natural query — a target username — actually return rows, matching the
    // toolbar placeholder. Capped so a broad term can't pull an unbounded set.
    //
    // RESILIENCE: the main-DB username→id resolution is the only main-DB
    // hit in this path. Wrap it in a bounded timeout + catch so a slow or
    // unavailable main DB degrades to "search the admin DB only" (still
    // matches admin_user_id / target_user_id / IP / admin username) instead
    // of throwing and digesting the whole /audit route. An empty match set
    // simply means the username branch contributes nothing — never an error.
    let matchedUserIds: string[] = [];
    try {
      matchedUserIds = (
        await withTimeout(
          () =>
            db.user.findMany({
              where: { username: { contains: search, mode: "insensitive" } },
              select: { id: true },
              take: 200,
            }),
          AUDIT_MAIN_DB_TIMEOUT_MS,
        )
      ).map((u) => u.id);
    } catch (err) {
      if (isQueryTimeoutError(err)) {
        logError("audit.search.userResolve", "username→id resolution timed out", err);
      } else {
        logError("audit.search.userResolve", "username→id resolution failed", err);
      }
      // Degrade: leave matchedUserIds empty so the OR still runs the
      // admin-DB-only branches below.
    }

    where.OR = [
      // Exact id branches keep the paste-a-UUID flow working.
      //
      // admin_user_id is a `@db.Uuid` column — comparing it against a
      // non-UUID string (e.g. a username like "FloridaManJeff") makes
      // Postgres throw `invalid input syntax for type uuid`, which is the
      // bug that digested the whole /audit route. Only include this branch
      // when the term is actually UUID-shaped. target_user_id is a plain
      // text column (it references the main DB's text user.id), so it never
      // casts and stays unconditional.
      ...(isUuid(search) ? [{ admin_user_id: search }] : []),
      { target_user_id: search },
      // IP as a prefix/substring match so partial / subnet lookups work
      // instead of requiring the exact stored string.
      { ip: { contains: search } },
      { admin_user: { username: { contains: search, mode: "insensitive" } } },
      ...(matchedUserIds.length > 0
        ? [{ target_user_id: { in: matchedUserIds } }]
        : []),
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

  // The display-hydration lookups (target usernames, promo-code ids,
  // chat-message bodies) all hit the MAIN DB. The audit events themselves
  // already loaded from the admin DB above, so a slow/failed main DB here
  // must NOT throw away the whole list — degrade to raw ids (no resolved
  // usernames / promo links / message previews) instead of digesting the
  // route. Bounded timeout + catch mirrors the search-resolution guard.
  let targetUsers: Array<{ id: string; username: string | null }> = [];
  let promoCodes: Array<{ id: string; code_hash: string }> = [];
  let messages: Array<{ id: string; content: string; is_deleted: boolean }> = [];
  try {
    [targetUsers, promoCodes, messages] = await withTimeout(
      () =>
        Promise.all([
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
        ]),
      AUDIT_MAIN_DB_TIMEOUT_MS,
    );
  } catch (err) {
    if (isQueryTimeoutError(err)) {
      logError("audit.hydrate", "main-DB display hydration timed out", err);
    } else {
      logError("audit.hydrate", "main-DB display hydration failed", err);
    }
    // Degrade: targetUsers/promoCodes/messages stay empty, so events render
    // with raw target ids and no promo/message enrichment — the audit trail
    // is still fully listed, just less decorated.
  }

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
