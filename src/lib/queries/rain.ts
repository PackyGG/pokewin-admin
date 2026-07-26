import { queryMainRows } from "@/lib/drizzle-query";
import { adminDrizzle } from "@/lib/drizzle";
import { admin_users } from "@/lib/db-schema/admin/schema";
import { toNumber } from "@/lib/utils/decimal";
import { isUuid } from "@/lib/utils/ids";
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
  const page = Math.max(1, Math.floor(params.page ?? 1));
  const perPage = Math.max(1, Math.min(200, Math.floor(params.perPage ?? 20)));
  const status = params.status && params.status !== "all" ? params.status : null;
  const search = params.search?.trim() || null;
  const searchId = search && isUuid(search) ? search : null;
  const numberOrNull = (value: number | undefined) =>
    value != null && Number.isFinite(value) ? value : null;
  type RainRow = {
    id: string;
    base_amount_usd: string;
    tip_amount_usd: string;
    total_pool_usd: string;
    status: string;
    participant_count: number;
    winner_username: string | null;
    starts_at: Date | string;
    ends_at: Date | string;
  };

  // List view skips provably-fair columns (server/client seeds, result
  // hashes) — those are only surfaced on the detail page.
  const [rains, total] = await Promise.all([
    queryMainRows<RainRow[]>(
      `SELECT r.id, r.base_amount_usd::text AS base_amount_usd,
              r.tip_amount_usd::text AS tip_amount_usd,
              r.total_pool_usd::text AS total_pool_usd,
              r.status::text AS status, r.participant_count,
              u.username AS winner_username, r.starts_at, r.ends_at
       FROM rains r
       LEFT JOIN "user" u ON u.id = r.winner_user_id
       WHERE ($1::text IS NULL OR r.status::text = $1)
         AND ($3::text IS NULL OR ($2::text IS NOT NULL AND r.id = $2::uuid)
              OR u.username ILIKE '%' || $3 || '%')
         AND ($4::numeric IS NULL OR r.tip_amount_usd >= $4)
         AND ($5::numeric IS NULL OR r.tip_amount_usd <= $5)
         AND ($6::numeric IS NULL OR r.total_pool_usd >= $6)
         AND ($7::numeric IS NULL OR r.total_pool_usd <= $7)
         AND ($8::integer IS NULL OR r.participant_count >= $8)
         AND ($9::integer IS NULL OR r.participant_count <= $9)
       ORDER BY r.created_at DESC
       LIMIT $10 OFFSET $11`,
      status, searchId, search, numberOrNull(params.minTips),
      numberOrNull(params.maxTips), numberOrNull(params.minPool),
      numberOrNull(params.maxPool), numberOrNull(params.minParticipants),
      numberOrNull(params.maxParticipants), perPage, (page - 1) * perPage,
    ),
    queryMainRows<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
       FROM rains r LEFT JOIN "user" u ON u.id = r.winner_user_id
       WHERE ($1::text IS NULL OR r.status::text = $1)
         AND ($3::text IS NULL OR ($2::text IS NOT NULL AND r.id = $2::uuid)
              OR u.username ILIKE '%' || $3 || '%')
         AND ($4::numeric IS NULL OR r.tip_amount_usd >= $4)
         AND ($5::numeric IS NULL OR r.tip_amount_usd <= $5)
         AND ($6::numeric IS NULL OR r.total_pool_usd >= $6)
         AND ($7::numeric IS NULL OR r.total_pool_usd <= $7)
         AND ($8::integer IS NULL OR r.participant_count >= $8)
         AND ($9::integer IS NULL OR r.participant_count <= $9)`,
      status, searchId, search, numberOrNull(params.minTips),
      numberOrNull(params.maxTips), numberOrNull(params.minPool),
      numberOrNull(params.maxPool), numberOrNull(params.minParticipants),
      numberOrNull(params.maxParticipants),
    ).then((rows) => Number(rows[0]?.count ?? 0)),
  ]);

  return {
    data: rains.map((r) => ({
      id: r.id,
      baseAmountUsd: toNumber(r.base_amount_usd),
      tipAmountUsd: toNumber(r.tip_amount_usd),
      totalPoolUsd: toNumber(r.total_pool_usd),
      status: r.status,
      participantCount: r.participant_count,
      winnerUsername: r.winner_username,
      startsAt: new Date(r.starts_at).toISOString(),
      endsAt: new Date(r.ends_at).toISOString(),
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
  const rain = (
    await queryMainRows<{
      id: string;
      status: string;
      base_amount_usd: string;
      tip_amount_usd: string;
      total_pool_usd: string;
      participant_count: number;
      starts_at: Date | string;
      ends_at: Date | string;
      completed_at: Date | string | null;
      winner_user_id: string | null;
      winner_username: string | null;
      tip_count: string;
    }[]>(
      `SELECT r.id, r.status::text AS status,
              r.base_amount_usd::text AS base_amount_usd,
              r.tip_amount_usd::text AS tip_amount_usd,
              r.total_pool_usd::text AS total_pool_usd,
              r.participant_count, r.starts_at, r.ends_at, r.completed_at,
              r.winner_user_id, u.username AS winner_username,
              COUNT(rt.id)::text AS tip_count
       FROM rains r
       LEFT JOIN "user" u ON u.id = r.winner_user_id
       LEFT JOIN rain_tips rt ON rt.rain_id = r.id
       WHERE r.id = $1::uuid
       GROUP BY r.id, u.username`,
      id,
    )
  )[0];

  if (!rain) return null;

  return {
    id: rain.id,
    status: rain.status,
    baseAmountUsd: toNumber(rain.base_amount_usd),
    tipAmountUsd: toNumber(rain.tip_amount_usd),
    totalPoolUsd: toNumber(rain.total_pool_usd),
    participantCount: rain.participant_count,
    startsAt: new Date(rain.starts_at).toISOString(),
    endsAt: new Date(rain.ends_at).toISOString(),
    completedAt: rain.completed_at ? new Date(rain.completed_at).toISOString() : null,
    winnerUserId: rain.winner_user_id,
    winnerUsername: rain.winner_username,
    tipCount: Number(rain.tip_count),
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
  const [tips, adminUsers] = await Promise.all([
    queryMainRows<{
      id: string;
      user_id: string;
      username: string | null;
      email: string | null;
      role: string | null;
      amount_usd: string;
      created_at: Date | string;
    }[]>(
      `SELECT rt.id, rt.user_id, u.username, u.email,
              u.role::text AS role, rt.amount_usd::text AS amount_usd,
              rt.created_at
       FROM rain_tips rt
       LEFT JOIN "user" u ON u.id = rt.user_id
       WHERE rt.rain_id = $1::uuid
       ORDER BY rt.created_at DESC`,
      id,
    ),
    adminDrizzle.select({ email: admin_users.email }).from(admin_users),
  ]);

  const adminEmails = new Set(adminUsers.map((a) => a.email));

  return tips.map((t) => {
    const isTeam =
      t.role === "admin" ||
      t.role === "support" ||
      (t.email ? adminEmails.has(t.email) : false);
    return {
      id: t.id,
      userId: t.user_id,
      username: t.username,
      amountUsd: toNumber(t.amount_usd),
      isTeamMember: isTeam,
      createdAt: new Date(t.created_at).toISOString(),
    };
  });
}

/** Server-side bounded, paginated entries for one rain. */
export async function getRainEntries(
  id: string,
  page = 1,
  perPage = 20,
): Promise<PaginatedResult<RainEntryItem>> {
  page = Math.max(1, Math.floor(page));
  perPage = Math.max(1, Math.min(200, Math.floor(perPage)));

  const [entries, total] = await Promise.all([
    queryMainRows<{
      id: string;
      user_id: string;
      username: string | null;
      turnstile_verified_at: Date | string;
      created_at: Date | string;
    }[]>(
      `SELECT re.id, re.user_id, u.username,
              re.turnstile_verified_at, re.created_at
       FROM rain_entries re
       LEFT JOIN "user" u ON u.id = re.user_id
       WHERE re.rain_id = $1::uuid
       ORDER BY re.created_at DESC
       LIMIT $2 OFFSET $3`,
      id,
      perPage,
      (page - 1) * perPage,
    ),
    queryMainRows<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count FROM rain_entries WHERE rain_id = $1::uuid`,
      id,
    ).then((rows) => Number(rows[0]?.count ?? 0)),
  ]);

  return {
    data: entries.map((e) => ({
      id: e.id,
      userId: e.user_id,
      username: e.username,
      turnstileVerifiedAt: new Date(e.turnstile_verified_at).toISOString(),
      createdAt: new Date(e.created_at).toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
