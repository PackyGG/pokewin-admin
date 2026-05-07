import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import type { CreatorListItem, UserSearchResult } from "./creators-types";

export async function searchNonCreatorUsers(search: string): Promise<UserSearchResult[]> {
  if (!search || search.length < 2) return [];

  const db = await getDb();
  const users = await db.user.findMany({
    where: {
      role: { not: "creator" },
      OR: [
        { username: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ],
    },
    select: { id: true, username: true, email: true, role: true },
    take: 5,
  });

  return users.map((u) => ({
    userId: u.id,
    username: u.username,
    email: u.email,
    role: u.role,
  }));
}

export async function getCreators(params: {
  page?: number;
  perPage?: number;
  search?: string;
  sortBy?: string;
  sortOrder?: string;
}): Promise<PaginatedResult<CreatorListItem>> {
  const {
    page = 1,
    perPage = 20,
    search,
    sortBy = "created_at",
    sortOrder = "desc",
  } = params;

  const db = await getDb();
  const where: Record<string, unknown> = {
    user: { role: "creator" },
  };

  if (search) {
    where.OR = [
      { user: { role: "creator", username: { contains: search, mode: "insensitive" } } },
      { user: { role: "creator", affiliate_code: { contains: search, mode: "insensitive" } } },
    ];
    // Override the top-level user filter when using OR
    delete where.user;
  }

  const validSortFields = ["created_at", "total_earned_usd", "total_referred"];
  const field = validSortFields.includes(sortBy) ? sortBy : "created_at";
  const direction = sortOrder === "asc" ? "ASC" : "DESC";

  // Build WHERE clause
  let whereClause = "WHERE u.role = 'creator'";
  const queryParams: string[] = [];
  if (search) {
    queryParams.push(`%${search}%`);
    whereClause = `WHERE u.role = 'creator' AND (u.username ILIKE $1 OR u.affiliate_code ILIKE $1)`;
  }

  const offset = (page - 1) * perPage;

  const [rows, countRows] = await Promise.all([
    db.$queryRawUnsafe<
      {
        user_id: string;
        total_referred: number;
        total_signups: string;
        total_earned_usd: string;
        available_usd: string;
        total_paid_out_usd: string;
        username: string | null;
        affiliate_code: string | null;
        first_code: string | null;
        // codes is a json_agg of {id, code} ordered by created_at
        // ASC, oldest first. NULL when the creator owns no codes —
        // unwrapped to [] in the mapper below. Single subquery keeps
        // this in the same round-trip rather than a separate fetch
        // per row.
        codes: { id: string; code: string }[] | null;
        currency_limit_amount: string | null;
        percentage_limit: string | null;
        currency_limit_reset_days: number | null;
      }[]
    >(
      `SELECT
        aa.user_id,
        aa.total_referred,
        (SELECT COUNT(*)::text FROM "user" ru WHERE ru.referred_by = aa.user_id) AS total_signups,
        aa.total_earned_usd::text,
        aa.available_usd::text,
        aa.total_paid_out_usd::text,
        u.username,
        u.affiliate_code,
        (SELECT ac.code FROM affiliate_codes ac WHERE ac.user_id = aa.user_id ORDER BY ac.created_at ASC LIMIT 1) AS first_code,
        (
          SELECT COALESCE(
            json_agg(json_build_object('id', ac.id, 'code', ac.code) ORDER BY ac.created_at ASC),
            '[]'::json
          )
          FROM affiliate_codes ac
          WHERE ac.user_id = aa.user_id
        ) AS codes,
        cwl.currency_limit_amount::text,
        cwl.percentage_limit::text,
        cwl.currency_limit_reset_days
      FROM affiliate_accounts aa
      JOIN "user" u ON u.id = aa.user_id
      LEFT JOIN creator_withdrawal_limits cwl ON cwl.user_id = aa.user_id
      ${whereClause}
      ORDER BY aa.${field} ${direction}
      LIMIT ${perPage} OFFSET ${offset}`,
      ...(search ? [`%${search}%`] : [])
    ),
    db.$queryRawUnsafe<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
      FROM affiliate_accounts aa
      JOIN "user" u ON u.id = aa.user_id
      ${whereClause}`,
      ...(search ? [`%${search}%`] : [])
    ),
  ]);

  const total = Number(countRows[0]?.count ?? 0);

  return {
    data: rows.map((r) => ({
      userId: r.user_id,
      username: r.username ?? null,
      code: r.affiliate_code ?? r.first_code ?? "",
      // Owned codes from affiliate_codes (oldest first). The
      // primary `code` field above is preserved for backwards
      // compatibility with the existing column. Empty array when
      // creator hasn't minted any codes yet.
      codes: r.codes ?? [],
      level: 1,
      totalReferred: r.total_referred,
      totalSignups: Number(r.total_signups),
      totalEarnedUsd: toNumber(r.total_earned_usd),
      availableUsd: toNumber(r.available_usd),
      totalPaidOutUsd: toNumber(r.total_paid_out_usd),
      limits: {
        currencyLimitAmount: r.currency_limit_amount ? toNumber(r.currency_limit_amount) : null,
        percentageLimit: r.percentage_limit ? toNumber(r.percentage_limit) : null,
        tipLimit: null,
        currencyLimitResetDays: r.currency_limit_reset_days ?? null,
      },
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
