import { adminDb } from "@/lib/admin-db";
import { getDb } from "@/lib/db";
import type { PaginatedResult } from "@/lib/types";

export async function getAdminUserDetail(id: string) {
  const db = await getDb();
  const user = await adminDb.admin_users.findUnique({
    where: { id },
    select: {
      id: true,
      email: true,
      username: true,
      role: true,
      totp_enabled: true,
      is_active: true,
      allowed_pages: true,
      created_at: true,
      updated_at: true,
    },
  });

  if (!user) return null;

  // For creators, resolve linked main site user by email match
  let linkedUser: { id: string; username: string | null } | null = null;
  if (user.role === "creator") {
    const mainUser = await db.user.findFirst({
      where: { email: user.email, role: "creator" },
      select: { id: true, username: true },
    });
    if (mainUser) linkedUser = mainUser;
  }

  return {
    id: user.id,
    email: user.email,
    username: user.username,
    role: user.role,
    totpEnabled: user.totp_enabled,
    isActive: user.is_active,
    allowedPages: user.allowed_pages,
    createdAt: user.created_at.toISOString(),
    updatedAt: user.updated_at.toISOString(),
    linkedUser,
  };
}

export type AdminUserDetail = NonNullable<Awaited<ReturnType<typeof getAdminUserDetail>>>;

type AdminSessionItem = {
  id: string;
  ip: string | null;
  userAgent: string | null;
  authMethod: string | null;
  loggedInAt: string;
  expiresAt: string;
  loggedOutAt: string | null;
  isActive: boolean;
};

export async function getAdminUserSessions(
  adminUserId: string,
  page: number = 1,
  perPage: number = 20
): Promise<PaginatedResult<AdminSessionItem>> {
  const [sessions, total] = await Promise.all([
    adminDb.admin_sessions.findMany({
      where: { admin_user_id: adminUserId },
      orderBy: { logged_in_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    adminDb.admin_sessions.count({ where: { admin_user_id: adminUserId } }),
  ]);

  const now = new Date();

  return {
    data: sessions.map((s) => ({
      id: s.id,
      ip: s.ip,
      userAgent: s.user_agent,
      authMethod: s.auth_method,
      loggedInAt: s.logged_in_at.toISOString(),
      expiresAt: s.expires_at.toISOString(),
      loggedOutAt: s.logged_out_at?.toISOString() ?? null,
      isActive: !s.logged_out_at && s.expires_at > now,
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getAdminUserAuditStats(adminUserId: string) {
  // Previously the daily series was a `groupBy(created_at)` — which buckets
  // per unique timestamp, not per day. For an active admin that pulled
  // back one row per event (thousands) and collapsed them in JS. Pushed
  // down into the DB via DATE() so we get exactly one row per day.
  //
  // totalActions is derived from the eventsByType groupBy in JS — Prisma
  // returns the per-type counts already, so a separate full-table count
  // is redundant.
  const [eventsByType, lastEvent, dailyCounts] = await Promise.all([
    adminDb.admin_audit_events.groupBy({
      by: ["event_type"],
      where: { admin_user_id: adminUserId },
      _count: true,
      orderBy: { _count: { event_type: "desc" } },
    }),
    adminDb.admin_audit_events.findFirst({
      where: { admin_user_id: adminUserId },
      orderBy: { created_at: "desc" },
      select: { created_at: true },
    }),
    adminDb.$queryRaw<{ date: Date; count: bigint }[]>`
      SELECT DATE(created_at AT TIME ZONE 'UTC') AS date,
             COUNT(*)::bigint AS count
      FROM admin_audit_events
      WHERE admin_user_id = ${adminUserId}::uuid
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at AT TIME ZONE 'UTC')
    `,
  ]);

  const totalActions = eventsByType.reduce(
    (sum, e) => sum + (typeof e._count === "number" ? e._count : 0),
    0,
  );

  const dailyMap = new Map<string, number>();
  for (const row of dailyCounts) {
    const date = new Date(row.date).toISOString().slice(0, 10);
    dailyMap.set(date, Number(row.count));
  }

  // Fill in all 30 days
  const dailyActivity: { date: string; count: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const date = d.toISOString().slice(0, 10);
    dailyActivity.push({ date, count: dailyMap.get(date) ?? 0 });
  }

  return {
    totalActions,
    lastActive: lastEvent?.created_at.toISOString() ?? null,
    eventsByType: eventsByType.map((e) => ({
      eventType: e.event_type,
      count: e._count,
    })),
    dailyActivity,
  };
}

export type AdminAuditStats = Awaited<ReturnType<typeof getAdminUserAuditStats>>;

type AdminAuditEventItem = {
  id: string;
  eventType: string;
  targetUserId: string | null;
  targetUsername: string | null;
  ip: string | null;
  metadata: unknown;
  createdAt: string;
};

export async function getAdminUserAuditEvents(
  adminUserId: string,
  page: number = 1,
  perPage: number = 20,
  filters?: { eventType?: string; search?: string }
): Promise<PaginatedResult<AdminAuditEventItem>> {
  const db = await getDb();
  const where: Record<string, unknown> = { admin_user_id: adminUserId };
  if (filters?.eventType && filters.eventType !== "all") {
    where.event_type = filters.eventType;
  }
  if (filters?.search) {
    // Try exact user ID match first, then search by username
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(filters.search);
    if (isUuid) {
      where.target_user_id = filters.search;
    } else {
      const matchingUsers = await db.user.findMany({
        where: { username: { contains: filters.search, mode: "insensitive" } },
        select: { id: true },
        take: 50,
      });
      const ids = matchingUsers.map((u) => u.id);
      where.target_user_id = ids.length > 0 ? { in: ids } : "__no_match__";
    }
  }

  const [events, total] = await Promise.all([
    adminDb.admin_audit_events.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    adminDb.admin_audit_events.count({ where }),
  ]);

  // Resolve target usernames from main DB
  const targetUserIds = [
    ...new Set(events.map((e) => e.target_user_id).filter(Boolean)),
  ] as string[];

  const usernameMap = new Map<string, string>();
  if (targetUserIds.length > 0) {
    const users = await db.user.findMany({
      where: { id: { in: targetUserIds } },
      select: { id: true, username: true, email: true },
    });
    for (const u of users) {
      usernameMap.set(u.id, u.username ?? u.email ?? u.id);
    }
  }

  return {
    data: events.map((e) => ({
      id: e.id,
      eventType: e.event_type,
      targetUserId: e.target_user_id,
      targetUsername: e.target_user_id
        ? usernameMap.get(e.target_user_id) ?? null
        : null,
      ip: e.ip,
      metadata: e.metadata,
      createdAt: e.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
