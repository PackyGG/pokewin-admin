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

/**
 * Detail header — everything the hero + KPI strip + Details panel needs,
 * and nothing that depends on the entries pagination cursor.
 *
 * Split out of the old monolithic `getRainDetail` so the summary boxes
 * (Total Pool / Tips / Participants / Winner) and the editable base-amount
 * panel resolve from ONE cheap PK lookup (+ a relation count) instead of
 * re-paying the tips relation load and the admin-emails fan-out on every
 * `?page=` change of the entries table. Tipper count comes from a relation
 * `_count` so the header never loads the tip rows themselves.
 *
 * Serializable by construction (Decimals → numbers, dates → ISO strings)
 * so it is safe to memoize in `unstable_cache` (see rain-detail-cache.ts).
 */
export type RainHeader = {
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
  tipCount: number;
};

export async function getRainHeader(id: string): Promise<RainHeader | null> {
  const db = await getDb();
  const rain = await db.rains.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      base_amount_usd: true,
      tip_amount_usd: true,
      total_pool_usd: true,
      participant_count: true,
      starts_at: true,
      ends_at: true,
      completed_at: true,
      winner_user_id: true,
      user: { select: { username: true } },
      _count: { select: { rain_tips: true } },
    },
  });

  if (!rain) return null;

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
    tipCount: rain._count.rain_tips,
  };
}

/**
 * Tips that fund one rain pool, with a team-member flag.
 *
 * Bounded by a single rain instance (not a lifetime scan). The tipper's
 * email is pulled only to cross-check against admin-DB team emails and is
 * never returned to the client. Admin emails are read from the Admin DB in
 * parallel (separate-DB lookup, joined in code — no cross-DB join).
 */
export async function getRainTips(id: string): Promise<RainTipItem[]> {
  const db = await getDb();
  const [tips, adminUsers] = await Promise.all([
    db.rain_tips.findMany({
      where: { rain_id: id },
      include: {
        user: { select: { username: true, email: true, role: true } },
      },
      orderBy: { created_at: "desc" },
    }),
    adminDb.admin_users.findMany({ select: { email: true } }),
  ]);

  const adminEmails = new Set(adminUsers.map((a) => a.email));

  return tips.map((t) => {
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
  });
}

/** Server-side bounded, paginated entries for one rain. */
export async function getRainEntries(
  id: string,
  page = 1,
  perPage = 20,
): Promise<PaginatedResult<RainEntryItem>> {
  const db = await getDb();

  const [entries, total] = await Promise.all([
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

  return {
    data: entries.map((e) => ({
      id: e.id,
      userId: e.user_id,
      username: e.user?.username ?? null,
      turnstileVerifiedAt: e.turnstile_verified_at.toISOString(),
      createdAt: e.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
