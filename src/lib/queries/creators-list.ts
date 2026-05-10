import { getDb } from "@/lib/db";
import { adminDb } from "@/lib/admin-db";
import { toNumber } from "@/lib/utils/decimal";
import { getExcludedUserIds } from "@/lib/excluded-users/fetch";
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
  const excluded = await getExcludedUserIds();
  const blacklistIdNotIn =
    excluded.length > 0
      ? `AND ru.id NOT IN (${excluded.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`
      : "";
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

  // Pull the set of creators who currently have at least one active
  // deal from the admin DB. "Active" = status='active' AND (no end
  // date OR end date in the future) so a row that's `active` on paper
  // but past its window doesn't float to the top.
  //
  // Cross-DB lookup, kept out of the WHERE clause — the rows query
  // uses it solely as a primary ORDER BY key. Empty array => everyone
  // gets `0` from the CASE expression and the secondary sort takes
  // over (stable behaviour when no creator has an active deal).
  const activeDealRows = await adminDb.creator_deals.findMany({
    where: {
      status: "active",
      OR: [{ end_date: null }, { end_date: { gt: new Date() } }],
    },
    distinct: ["target_user_id"],
    select: { target_user_id: true },
  });
  const activeDealUserIds = activeDealRows.map((d) => d.target_user_id);

  // Build WHERE clause + param list. The active-deal array gets
  // appended AFTER any search param so its $-index is stable
  // (`$N+1` where N = whereParams.length).
  let whereClause = "WHERE u.role = 'creator'";
  const whereParams: string[] = [];
  if (search) {
    whereParams.push(`%${search}%`);
    whereClause = `WHERE u.role = 'creator' AND (u.username ILIKE $1 OR u.affiliate_code ILIKE $1)`;
  }
  // Param list for the rows query: search pattern (if any) + the
  // active-deal user_id array. The placeholder index for the array
  // depends on whether search added a param first.
  const rowsParams: unknown[] = [...whereParams, activeDealUserIds];
  const activeArrayPlaceholder = `$${rowsParams.length}`;

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
        // 3-day rolling deposit + wager volume from this creator's
        // referrals — surfaces "is this creator producing right now?"
        // signal on the row. Source matches the staff-excluded
        // creator-detail KPIs: affiliate_code_usages joined to
        // user with role NOT IN ('admin','support').
        deposits_3d: string;
        wagers_3d: string;
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
        -- 3-day deposit volume from this creator's referrals.
        -- affiliate_code_usages.deposit_amount_usd is the FTD value
        -- per backend convention; sum over the 3-day window only.
        -- Staff (admin / support) excluded so internal accounts don't
        -- skew per-creator momentum.
        COALESCE((
          SELECT SUM(acu.deposit_amount_usd::numeric)
          FROM affiliate_code_usages acu
          JOIN "user" ru ON ru.id = acu.referred_user_id
          WHERE acu.affiliate_user_id = aa.user_id
            AND acu.created_at >= NOW() - INTERVAL '3 days'
            AND ru.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
        ), 0)::text AS deposits_3d,
        -- 3-day wager volume — same source + same staff filter.
        COALESCE((
          SELECT SUM(acu.wager_amount_usd::numeric)
          FROM affiliate_code_usages acu
          JOIN "user" ru ON ru.id = acu.referred_user_id
          WHERE acu.affiliate_user_id = aa.user_id
            AND acu.created_at >= NOW() - INTERVAL '3 days'
            AND ru.role NOT IN ('admin', 'support') ${blacklistIdNotIn}
        ), 0)::text AS wagers_3d,
        cwl.currency_limit_amount::text,
        cwl.percentage_limit::text,
        cwl.currency_limit_reset_days
      FROM affiliate_accounts aa
      JOIN "user" u ON u.id = aa.user_id
      LEFT JOIN creator_withdrawal_limits cwl ON cwl.user_id = aa.user_id
      ${whereClause}
      ORDER BY
        (CASE WHEN aa.user_id = ANY(${activeArrayPlaceholder}::text[]) THEN 1 ELSE 0 END) DESC,
        aa.${field} ${direction}
      LIMIT ${perPage} OFFSET ${offset}`,
      ...rowsParams,
    ),
    db.$queryRawUnsafe<{ count: string }[]>(
      `SELECT COUNT(*)::text AS count
      FROM affiliate_accounts aa
      JOIN "user" u ON u.id = aa.user_id
      ${whereClause}`,
      ...whereParams,
    ),
  ]);

  const total = Number(countRows[0]?.count ?? 0);

  // Set lookup so each row can carry a `hasActiveDeal` flag — drives
  // the small "Active" dot in the Username column so the admin sees
  // why these rows are on top.
  const activeDealSet = new Set(activeDealUserIds);

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
      hasActiveDeal: activeDealSet.has(r.user_id),
      level: 1,
      totalReferred: r.total_referred,
      totalSignups: Number(r.total_signups),
      totalEarnedUsd: toNumber(r.total_earned_usd),
      availableUsd: toNumber(r.available_usd),
      totalPaidOutUsd: toNumber(r.total_paid_out_usd),
      // 3-day rolling momentum from this creator's affiliates.
      // Staff (admin / support) excluded at the query level.
      deposits3dUsd: toNumber(r.deposits_3d),
      wagers3dUsd: toNumber(r.wagers_3d),
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
