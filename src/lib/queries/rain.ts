import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";

export type RainListItem = {
  id: string;
  baseAmountUsd: number;
  tipAmountUsd: number;
  totalPoolUsd: number;
  status: string;
  participantCount: number;
  winnerUsername: string | null;
  startsAt: string;
  endsAt: string;
};

export async function getRains(params: {
  page?: number;
  perPage?: number;
  search?: string;
  status?: string;
  minTips?: number;
  maxTips?: number;
  minPool?: number;
  maxPool?: number;
  minParticipants?: number;
  maxParticipants?: number;
}): Promise<PaginatedResult<RainListItem>> {
  const db = await getDb();
  const { page = 1, perPage = 20, status, search } = params;

  const where: Record<string, unknown> = {};
  if (status && status !== "all") {
    where.status = status;
  }

  if (search) {
    const isUuid = /^[0-9a-f]{8}-/i.test(search);
    where.OR = [
      ...(isUuid ? [{ id: search }] : []),
      { user: { username: { contains: search, mode: "insensitive" } } },
    ];
  }

  const tipFilter: Record<string, number> = {};
  if (params.minTips != null && !isNaN(params.minTips)) tipFilter.gte = params.minTips;
  if (params.maxTips != null && !isNaN(params.maxTips)) tipFilter.lte = params.maxTips;
  if (Object.keys(tipFilter).length > 0) where.tip_amount_usd = tipFilter;

  const poolFilter: Record<string, number> = {};
  if (params.minPool != null && !isNaN(params.minPool)) poolFilter.gte = params.minPool;
  if (params.maxPool != null && !isNaN(params.maxPool)) poolFilter.lte = params.maxPool;
  if (Object.keys(poolFilter).length > 0) where.total_pool_usd = poolFilter;

  const partFilter: Record<string, number> = {};
  if (params.minParticipants != null && !isNaN(params.minParticipants)) partFilter.gte = params.minParticipants;
  if (params.maxParticipants != null && !isNaN(params.maxParticipants)) partFilter.lte = params.maxParticipants;
  if (Object.keys(partFilter).length > 0) where.participant_count = partFilter;

  // List view skips provably-fair columns (server/client seeds, result
  // hashes) — those are only surfaced on the detail page.
  const [rains, total] = await Promise.all([
    db.rains.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      select: {
        id: true,
        base_amount_usd: true,
        tip_amount_usd: true,
        total_pool_usd: true,
        status: true,
        participant_count: true,
        starts_at: true,
        ends_at: true,
        user: { select: { username: true } },
      },
    }),
    db.rains.count({ where }),
  ]);

  return {
    data: rains.map((r) => ({
      id: r.id,
      baseAmountUsd: toNumber(r.base_amount_usd),
      tipAmountUsd: toNumber(r.tip_amount_usd),
      totalPoolUsd: toNumber(r.total_pool_usd),
      status: r.status,
      participantCount: r.participant_count,
      winnerUsername: r.user?.username ?? null,
      startsAt: r.starts_at.toISOString(),
      endsAt: r.ends_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export type RainTipItem = {
  id: string;
  userId: string;
  username: string | null;
  amountUsd: number;
  isTeamMember: boolean;
  createdAt: string;
};

export type RainEntryItem = {
  id: string;
  userId: string;
  username: string | null;
  turnstileVerifiedAt: string;
  createdAt: string;
};

export type RainDetail = {
  id: string;
  status: string;
  baseAmountUsd: number;
  tipAmountUsd: number;
  totalPoolUsd: number;
  participantCount: number;
  startsAt: string;
  endsAt: string;
  completedAt: string | null;
  winnerUserId: string | null;
  winnerUsername: string | null;
  tips: RainTipItem[];
  entries: PaginatedResult<RainEntryItem>;
};

export async function getRainDetail(
  id: string,
  params: { page?: number; perPage?: number },
): Promise<RainDetail | null> {
  const db = await getDb();
  const { page = 1, perPage = 20 } = params;

  // Rain, admin-users (for team check) and paginated entries are independent —
  // fetch them in parallel. Tipper-user emails were a serial second hop in
  // the previous version, but the rain.rain_tips relation already pulls
  // each tipper's role. We can fold the email into the relation `select`
  // to keep the second hop off the wire entirely — the tipper's email isn't
  // returned to the client, it's only used here to cross-check against
  // admin-DB team emails.
  const [rain, adminUsers, entries, totalEntries] = await Promise.all([
    db.rains.findUnique({
      where: { id },
      include: {
        user: { select: { username: true } },
        rain_tips: {
          include: {
            user: { select: { username: true, email: true, role: true } },
          },
          orderBy: { created_at: "desc" },
        },
      },
    }),
    adminDb.admin_users.findMany({ select: { email: true } }),
    db.rain_entries.findMany({
      where: { rain_id: id },
      select: {
        id: true,
        user_id: true,
        turnstile_verified_at: true,
        created_at: true,
        user: { select: { username: true } },
      },
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    db.rain_entries.count({ where: { rain_id: id } }),
  ]);

  if (!rain) return null;

  const adminEmails = new Set(adminUsers.map((a) => a.email));

  return {
    id: rain.id,
    status: rain.status,
    baseAmountUsd: toNumber(rain.base_amount_usd),
    tipAmountUsd: toNumber(rain.tip_amount_usd),
    totalPoolUsd: toNumber(rain.total_pool_usd),
    participantCount: rain.participant_count,
    startsAt: rain.starts_at.toISOString(),
    endsAt: rain.ends_at.toISOString(),
    completedAt: rain.completed_at?.toISOString() ?? null,
    winnerUserId: rain.winner_user_id,
    winnerUsername: rain.user?.username ?? null,
    tips: rain.rain_tips.map((t) => {
      const isTeam =
        t.user?.role === "admin" ||
        t.user?.role === "support" ||
        (t.user?.email ? adminEmails.has(t.user.email) : false);
      return {
        id: t.id,
        userId: t.user_id,
        username: t.user?.username ?? null,
        amountUsd: toNumber(t.amount_usd),
        isTeamMember: isTeam,
        createdAt: t.created_at.toISOString(),
      };
    }),
    entries: {
      data: entries.map((e) => ({
        id: e.id,
        userId: e.user_id,
        username: e.user?.username ?? null,
        turnstileVerifiedAt: e.turnstile_verified_at.toISOString(),
        createdAt: e.created_at.toISOString(),
      })),
      total: totalEntries,
      page,
      perPage,
      totalPages: Math.ceil(totalEntries / perPage),
    },
  };
}
