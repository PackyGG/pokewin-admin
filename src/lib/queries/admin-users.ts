import { adminDb } from "@/lib/admin-db";
import { getDb } from "@/lib/db";
import { getEffectiveRoles } from "@/lib/admin-roles";
import { readAdminUserWithRoles } from "@/lib/admin-user-roles";
import { ROLE_BASELINES, baselineTokensFor } from "@/lib/role-baselines";
import type { PermissionToken } from "@/lib/permissions/types";
import type { PaginatedResult } from "@/lib/types";

export async function getAdminUserDetail(id: string) {
  const db = await getDb();
  // Resilient to the unapplied `roles` migration: degrades to `roles: []`
  // (→ effective `[role]` below) so the detail page renders pre-migration.
  // The per-user override columns (permission_grants / permission_revokes)
  // are selected in BOTH variants — they exist in prod (applied + verified);
  // the write side (loadUserPermissionState) carries the extra P2022 degrade.
  const user = await readAdminUserWithRoles(
    () =>
      adminDb.admin_users.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          username: true,
          role: true,
          roles: true,
          role_id: true,
          custom_role: { select: { id: true, name: true, capabilities: true } },
          totp_enabled: true,
          is_active: true,
          is_owner: true,
          allowed_pages: true,
          permission_grants: true,
          permission_revokes: true,
          created_at: true,
          updated_at: true,
        },
      }),
    () =>
      adminDb.admin_users.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          username: true,
          role: true,
          role_id: true,
          custom_role: { select: { id: true, name: true, capabilities: true } },
          totp_enabled: true,
          is_active: true,
          is_owner: true,
          allowed_pages: true,
          permission_grants: true,
          permission_revokes: true,
          created_at: true,
          updated_at: true,
        },
      }),
  );

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

  // The degrade branch of readAdminUserWithRoles injects `roles: string[]`
  // but never touches the override columns (selected in both variants), so
  // they're always present — narrow the union for the fields we read below.
  const u = user as typeof user & {
    roles?: string[] | null;
    permission_grants: string[];
    permission_revokes: string[];
    // `is_owner` is selected in both variants; on a pre-migration DB it may be
    // absent, so treat it as optional and default to false below.
    is_owner?: boolean | null;
  };

  const effRoles = getEffectiveRoles(u.role, u.roles);
  const customRoleTokens: PermissionToken[] = u.custom_role?.capabilities ?? [];

  // Per-role baseline attribution for the editor's read-only baseline view:
  // for every token a built-in role baseline confers, record which role(s)
  // grant it (so each token can be badged `from <role>`). Built-in baselines
  // come from the code-defined ROLE_BASELINES (label resolved for display).
  const baselineByToken = new Map<PermissionToken, string[]>();
  for (const r of effRoles) {
    const label = (ROLE_BASELINES as Record<string, { label: string } | undefined>)[r]
      ?.label ?? r;
    for (const token of baselineTokensFor(r)) {
      const list = baselineByToken.get(token) ?? [];
      if (!list.includes(label)) list.push(label);
      baselineByToken.set(token, list);
    }
  }
  // Custom-role capabilities also form part of the baseline (Layer 2).
  if (customRoleTokens.length > 0) {
    const customLabel = u.custom_role?.name
      ? `role "${u.custom_role.name}"`
      : "custom role";
    for (const token of customRoleTokens) {
      const list = baselineByToken.get(token) ?? [];
      if (!list.includes(customLabel)) list.push(customLabel);
      baselineByToken.set(token, list);
    }
  }
  const baselineTokens: { token: PermissionToken; from: string[] }[] = [
    ...baselineByToken.entries(),
  ].map(([token, from]) => ({ token, from }));

  // Whether any built-in role in the user's set is a gate-bypass role (admin).
  // The editor shows a "full access — overrides recorded but not enforced"
  // banner instead of an effective list for such users.
  const isGateBypass = effRoles.some(
    (r) =>
      (ROLE_BASELINES as Record<string, { bypass: boolean } | undefined>)[r]
        ?.bypass === true,
  );

  // Sticky tokens (re-granted by the runtime self-heals on the role's landing
  // page even if revoked per-user) — surfaced so the editor can warn that a
  // revoke "will re-grant on page load". Union the stickyTokens of every
  // built-in role the user holds.
  const stickyTokens = [
    ...new Set(
      effRoles.flatMap(
        (r) =>
          (ROLE_BASELINES as Record<string, { stickyTokens: string[] } | undefined>)[
            r
          ]?.stickyTokens ?? [],
      ),
    ),
  ];

  return {
    id: u.id,
    email: u.email,
    username: u.username,
    // Primary/canonical system role (highest-privilege of `roles`).
    role: u.role,
    // Full effective system-role set. Legacy single-role users (empty
    // `roles` column) collapse to `[role]` via getEffectiveRoles, so the
    // UI always has a non-empty list to render + preselect.
    roles: effRoles,
    // Assigned custom-role preset (admin_roles). null = no preset; the
    // user's allowed_pages are then purely per-user. roleName +
    // roleCapabilities are carried for display so the profile's
    // permission editor can flag per-user overrides vs the role baseline.
    roleId: u.role_id,
    roleName: u.custom_role?.name ?? null,
    roleCapabilities: u.custom_role?.capabilities ?? null,
    totpEnabled: u.totp_enabled,
    isActive: u.is_active,
    // OWNER / ultra-admin state. `isOwner` is the EFFECTIVE flag (the raw
    // `is_owner` column OR the permanent `motha` username bypass) — used to
    // render the badge + the toggle's current position. `isMainOwner` marks the
    // permanent root owner, whose status is read-only (cannot be toggled).
    isOwner:
      (u.is_owner ?? false) ||
      (u.username ?? "").trim().toLowerCase() === "motha",
    isMainOwner: (u.username ?? "").trim().toLowerCase() === "motha",
    allowedPages: u.allowed_pages,
    // ── Phase C per-user override layer ──
    // The explicit grant/revoke columns (the EDITABLE source). Empty for a
    // never-edited user; allowedPages stays the derived runtime cache.
    permissionGrants: u.permission_grants ?? [],
    permissionRevokes: u.permission_revokes ?? [],
    // The role baseline (built-in + custom-role tokens) with per-token role
    // attribution, rendered read-only in the editor.
    baselineTokens,
    // Custom-role capability tokens (already counted in baselineTokens; kept
    // separately so the editor can compute the effective preview client-side).
    customRoleTokens,
    // Whether the user bypasses the gate (admin) → editor shows a banner.
    isGateBypass,
    // Tokens the runtime self-heals re-grant on page load even if revoked.
    stickyTokens,
    createdAt: u.created_at.toISOString(),
    updatedAt: u.updated_at.toISOString(),
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

export type AdminAuditEventItem = {
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
