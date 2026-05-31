import { unstable_cache } from "next/cache";
import { getDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";
import { user_role } from "@/generated/prisma/enums";
import {
  computeRiskScoresForList,
  type RiskTier,
} from "@/lib/fraud/score";
import { calculateUsersPnlBatch } from "./pnl";

// Allowlist from the generated Prisma user_role enum — validate the
// role filter before it reaches either the Prisma where or the raw-SQL
// sort branch, instead of an unchecked cast.
const USER_ROLES = new Set<string>(Object.values(user_role));

type UserListItem = {
  id: string;
  username: string | null;
  email: string | null;
  image: string | null;
  role: string;
  status: string;
  country: string | null;
  countryCode: string | null;
  availableBalance: number;
  inventoryValue: number;
  totalDeposited: number;
  totalWithdrawn: number;
  totalWagered: number;
  depositCount: number;
  pnl: number;
  /**
   * Combined on-platform holdings = available + locked balance +
   * unsold/unexchanged inventory value + unclaimed voucher value.
   * Vouchers count as inventory exactly like cards (cards + vouchers
   * = inventory), so they're part of the on-site position. This is the
   * user's TOTAL position on-site right now, which from the house POV
   * is the direct liability per user. Useful for spotting whales
   * without having to mentally add the Balance + Inventory columns.
   */
  netHoldings: number;
  createdAt: string;
  riskScore: number;
  riskTier: RiskTier;
  sharedIpCount: number;
  sharedFingerprintCount: number;
};

export async function getUsers(params: {
  page?: number;
  perPage?: number;
  search?: string;
  role?: string;
  status?: string;
  sortBy?: string;
  sortOrder?: string;
}): Promise<PaginatedResult<UserListItem>> {
  const db = await getDb();
  const {
    page = 1,
    perPage = 20,
    search,
    role,
    status,
    sortBy = "created_at",
    sortOrder = "desc",
  } = params;

  const where: Prisma.UserWhereInput = {};

  // Trim so stray leading/trailing whitespace (easy to paste in by
  // accident) doesn't turn a valid handle into a miss.
  const searchTerm = search?.trim();

  // ── Search fast paths ──────────────────────────────────────────────
  // The legacy code path ORed 4× ILIKE '%term%' across username /
  // display_username / name / email. ILIKE with a leading % can't use
  // the B-tree indexes Postgres has on `user.email` / `user.username`
  // (user_email_unique / user_username_unique) / `user.id` (PK), so
  // every keystroke triggered a full sequential scan of the `user`
  // table. On a multi-million row prod table that's seconds per
  // request — the slow search admins were hitting.
  //
  // Recognising the input shape lets us route to an equality lookup
  // (O(log n) on the unique index) for the inputs that don't need
  // substring matching: UUIDs (= primary key), email-format strings
  // (= unique email index), and Discord snowflakes (= account join).
  // Pure-handle queries still fall back to the ILIKE OR so substring
  // matches keep working — they're slow only when the operator
  // genuinely types a partial handle / display name / OAuth name.
  // A pg_trgm GIN index on lower(username) / lower(name) is the
  // canonical way to speed that fallback up; coordinate before
  // adding it to prod since this is the main DB.
  const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isUuid = UUID_RE.test(searchTerm ?? "");
  // Cheap email shape check — anything with an @ that isn't trivially
  // malformed. We don't require a full RFC-compliant match; the unique
  // email index settles the result either way.
  const isEmailLike =
    !!searchTerm && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(searchTerm);
  // Discord snowflake IDs are 17-20 digit numeric strings. We match the
  // linked Discord account (account.providerId = 'discord', account.accountId
  // = snowflake) only when the search looks like one — otherwise a generic
  // numeric username would trigger an unnecessary join.
  const isDiscordId = /^\d{17,20}$/.test(searchTerm ?? "");

  if (searchTerm) {
    if (isUuid) {
      // Primary-key lookup — single index hit.
      where.id = searchTerm;
    } else if (isEmailLike) {
      // user.email has a unique index — equality lookup is O(log n).
      // mode insensitive normalises case for the rare user whose
      // email was stored mixed-case before the lowercasing pass.
      where.email = { equals: searchTerm, mode: "insensitive" };
    } else if (isDiscordId) {
      // account.accountId is indexed; the EXISTS subquery is a single
      // index seek per matching row.
      where.account = {
        some: { providerId: "discord", accountId: searchTerm },
      };
    } else {
      // Substring fallback — the slow path. Search the handle, the
      // display name + OAuth name (so a user can be found by what
      // Discord/Google shows, not just the lowercase handle), and the
      // email; id is included for short partial UUID pastes that
      // didn't pass UUID_RE. Only runs when the input shape didn't
      // match any fast path above.
      where.OR = [
        { username: { contains: searchTerm, mode: "insensitive" } },
        { display_username: { contains: searchTerm, mode: "insensitive" } },
        { name: { contains: searchTerm, mode: "insensitive" } },
        { email: { contains: searchTerm, mode: "insensitive" } },
        { id: searchTerm },
      ];
    }
  }

  if (role && role !== "all" && USER_ROLES.has(role)) {
    where.role = role as user_role;
  }

  if (status === "banned") where.is_banned = true;
  else if (status === "locked") where.is_locked = true;
  else if (status === "active") {
    where.is_banned = false;
    where.is_locked = false;
  }

  const order = sortOrder === "asc" ? "asc" : "desc";
  const balanceSortFields = new Set([
    "balance",
    "totalDeposited",
    "totalWagered",
  ]);
  const userSortFields = new Set(["created_at", "email", "username", "role", "country"]);

  // Narrow projection — only the columns the list view actually renders.
  // The `user` table has 50+ columns; pulling them all back per page row
  // adds non-trivial bytes on every list query. Keep select in sync with
  // the fields read in the `data` mapping at the bottom of this file.
  const userSelect = {
    id: true,
    username: true,
    email: true,
    image: true,
    role: true,
    is_banned: true,
    is_locked: true,
    country: true,
    country_code: true,
    created_at: true,
    balances: {
      select: {
        available_balance: true,
        locked_balance: true,
        total_deposited: true,
        total_withdrawn: true,
        total_wagered: true,
      },
    },
  } satisfies Prisma.UserSelect;

  let users: Array<Prisma.UserGetPayload<{ select: typeof userSelect }>>;
  let total: number;

  // These computed sorts need raw SQL because the displayed value combines
  // multiple tables (e.g. totalWithdrawn = balances.total_withdrawn +
  // card_withdrawal_requests; netHoldings = balances + user_inventory).
  const rawSqlSorts = new Set([
    "pnl",
    "totalWithdrawn",
    "inventoryValue",
    "netHoldings",
  ]);

  if (rawSqlSorts.has(sortBy)) {
    const orderSql = order === "asc" ? "ASC" : "DESC";
    const whereSql: string[] = [];
    if (searchTerm) {
      // Same fast-path routing as the Prisma path above — uuid /
      // email-shape / discord-snowflake hit indexes directly; only
      // free-form text falls back to the multi-column ILIKE OR. The
      // safe-quoted literal is reused everywhere a substring isn't
      // wrapped in % wildcards so apostrophes can't break out.
      const safe = searchTerm.replace(/'/g, "''");
      if (isUuid) {
        whereSql.push(`u.id = '${safe}'`);
      } else if (isEmailLike) {
        whereSql.push(`LOWER(u.email) = LOWER('${safe}')`);
      } else if (isDiscordId) {
        whereSql.push(
          `EXISTS (SELECT 1 FROM account a WHERE a."userId" = u.id AND a."providerId" = 'discord' AND a."accountId" = '${safe}')`,
        );
      } else {
        whereSql.push(
          `(u.username ILIKE '%${safe}%' OR u.display_username ILIKE '%${safe}%' OR u.name ILIKE '%${safe}%' OR u.email ILIKE '%${safe}%' OR u.id = '${safe}')`,
        );
      }
    }
    if (role && role !== "all" && USER_ROLES.has(role)) {
      // role is validated against the user_role enum above, so it's a
      // known alphanumeric member; inline it safely.
      whereSql.push(`u.role = '${role}'::user_role`);
    }
    if (status === "banned") whereSql.push("u.is_banned = true");
    else if (status === "locked") whereSql.push("u.is_locked = true");
    else if (status === "active")
      whereSql.push("u.is_banned = false AND u.is_locked = false");
    const whereClause = whereSql.length ? `WHERE ${whereSql.join(" AND ")}` : "";

    const orderedRows = await db.$queryRawUnsafe<{ id: string }[]>(`
      SELECT u.id
      FROM "user" u
      LEFT JOIN balances b ON b.user_id = u.id
      LEFT JOIN (
        SELECT user_id, COALESCE(SUM(value_at_obtained::numeric), 0) AS inv_value
        FROM user_inventory
        WHERE sold_at IS NULL AND exchanged_at IS NULL
        GROUP BY user_id
      ) inv ON inv.user_id = u.id
      LEFT JOIN (
        SELECT user_id, COALESCE(SUM(total_value_usd::numeric), 0) AS wd_value
        FROM card_withdrawal_requests
        WHERE status IN ('completed', 'shipped')
        GROUP BY user_id
      ) cw ON cw.user_id = u.id
      LEFT JOIN (
        SELECT user_id, COALESCE(SUM(value::numeric), 0) AS voucher_value
        FROM vouchers
        WHERE claimed_at IS NULL
        GROUP BY user_id
      ) vc ON vc.user_id = u.id
      ${whereClause}
      ORDER BY (${
        sortBy === "totalWithdrawn"
          ? `COALESCE(b.total_withdrawn::numeric, 0) + COALESCE(cw.wd_value, 0)`
          : sortBy === "inventoryValue"
            ? `COALESCE(inv.inv_value, 0)`
            : sortBy === "netHoldings"
              ? // Net on-platform position from the house POV: cash
                // (available + locked) + open inventory + unclaimed
                // vouchers. Vouchers count as inventory exactly like
                // cards (cards + vouchers = inventory), so they belong
                // in the on-site holdings snapshot. This is the "what
                // the user has on-site RIGHT NOW" snapshot — ignores
                // lifetime deposits/withdrawals/PnL so big holders
                // surface even if they never wagered. Must stay in sync
                // with the JS netHoldings computed in the data mapping.
                `COALESCE(b.available_balance::numeric, 0)
                 + COALESCE(b.locked_balance::numeric, 0)
                 + COALESCE(inv.inv_value, 0)
                 + COALESCE(vc.voucher_value, 0)`
              : `COALESCE(b.total_withdrawn::numeric, 0) + COALESCE(cw.wd_value, 0)
               + COALESCE(b.available_balance::numeric, 0)
               + COALESCE(b.locked_balance::numeric, 0)
               + COALESCE(inv.inv_value, 0)
               + COALESCE(vc.voucher_value, 0)
               - COALESCE(b.total_deposited::numeric, 0)`
      }) ${orderSql} NULLS LAST, u.id ${orderSql}
      LIMIT ${perPage} OFFSET ${(page - 1) * perPage}
    `);

    const ids = orderedRows.map((r) => r.id);
    const [unordered, totalCount] = await Promise.all([
      ids.length > 0
        ? db.user.findMany({
            where: { id: { in: ids } },
            select: userSelect,
          })
        : Promise.resolve([] as typeof users),
      db.user.count({ where }),
    ]);
    const byId = new Map(unordered.map((u) => [u.id, u]));
    users = ids
      .map((id) => byId.get(id))
      .filter((u): u is (typeof unordered)[number] => Boolean(u));
    total = totalCount;
  } else {
    let orderBy: Prisma.UserOrderByWithRelationInput;
    if (balanceSortFields.has(sortBy)) {
      const balanceField = (
        {
          balance: "available_balance",
          totalDeposited: "total_deposited",
          totalWagered: "total_wagered",
        } as Record<string, string>
      )[sortBy];
      orderBy = {
        balances: {
          [balanceField]: order,
        } as Prisma.balancesOrderByWithRelationInput,
      };
    } else {
      const field = userSortFields.has(sortBy) ? sortBy : "created_at";
      orderBy = { [field]: order } as Prisma.UserOrderByWithRelationInput;
    }

    const result = await Promise.all([
      db.user.findMany({
        where,
        orderBy,
        skip: (page - 1) * perPage,
        take: perPage,
        select: userSelect,
      }),
      db.user.count({ where }),
    ]);
    users = result[0];
    total = result[1];
  }

  // Per-page aggregates are independent keyed on user_id and run in
  // parallel. The P&L components (inventory / card-withdrawals / vouchers
  // / balances) are bundled in calculateUsersPnlBatch so the canonical
  // formula lives in exactly one place. depositCount and riskScore stay
  // separate — they're used for other columns.
  const userIds = users.map((u) => u.id);
  const empty = {
    deposits: [] as Array<{ user_id: string; _count: { _all: number } }>,
  };
  const [pnlByUserId, depositCountRows, riskScoresMap] = await Promise.all([
    calculateUsersPnlBatch(userIds),
    userIds.length > 0
      ? db.ledger_transactions.groupBy({
          by: ["user_id"],
          where: {
            user_id: { in: userIds },
            type: "deposit",
            status: "completed",
          },
          _count: { _all: true },
        })
      : Promise.resolve(empty.deposits),
    // Risk score — batched internally for the whole page.
    userIds.length > 0
      ? computeRiskScoresForList(userIds)
      : Promise.resolve(
          new Map<string, { score: number; tier: RiskTier; sharedIpCount: number; sharedFingerprintCount: number }>(),
        ),
  ]);

  const depositCountMap = new Map(
    depositCountRows.map((d) => [d.user_id, d._count._all]),
  );

  return {
    data: users.map((u) => {
      const availableBalance = toNumber(u.balances?.available_balance);
      const lockedBalance = toNumber(u.balances?.locked_balance);
      const totalWagered = toNumber(u.balances?.total_wagered);
      const userPnl = pnlByUserId.get(u.id);
      const totalDeposited = userPnl?.deposits ?? 0;
      const totalWithdrawn = userPnl?.withdrawals ?? 0;
      const inventoryValue = userPnl?.inventoryValue ?? 0;
      const unclaimedVouchers = userPnl?.unclaimedVouchers ?? 0;
      // The data-table renders user-POV pnl (positive = user winning,
      // shown red because that's our liability). The shared helper returns
      // House-POV; flip the sign here to keep the column semantics intact.
      const pnl = userPnl ? -userPnl.pnl : 0;
      // Net on-platform holdings = cash (available + locked vault) +
      // open inventory + unclaimed vouchers. Vouchers are inventory
      // exactly like cards (cards + vouchers = inventory), so they're
      // part of what the user holds on-site. Mirrors the SQL ORDER BY
      // expression for the `netHoldings` sort so client-side reordering
      // matches what the server returned. Lifetime deposits/withdrawals
      // deliberately excluded — this is "what's on-site RIGHT NOW", not
      // PnL.
      const netHoldings =
        availableBalance + lockedBalance + inventoryValue + unclaimedVouchers;
      const risk = riskScoresMap.get(u.id);
      return {
        id: u.id,
        username: u.username,
        email: u.email,
        image: u.image,
        role: u.role,
        status: u.is_banned ? "banned" : u.is_locked ? "locked" : "active",
        country: u.country,
        countryCode: u.country_code,
        availableBalance,
        inventoryValue,
        netHoldings,
        totalDeposited,
        totalWithdrawn,
        totalWagered,
        depositCount: depositCountMap.get(u.id) ?? 0,
        pnl,
        createdAt: u.created_at.toISOString(),
        riskScore: risk?.score ?? 0,
        riskTier: risk?.tier ?? ("low" as RiskTier),
        sharedIpCount: risk?.sharedIpCount ?? 0,
        sharedFingerprintCount: risk?.sharedFingerprintCount ?? 0,
      };
    }),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

// ─── Global KPI stats for the /users page hero strip ──────────────────
//
// Counts that describe the WHOLE user base, independent of the current
// page / search / role / status filter. The headline tiles on /users
// read off this so they stay stable as admins paginate or refine the
// table — switching to a search term doesn't make "Banned" suddenly
// read as the banned count of just the current page slice.
//
// Three COUNT(*) FILTER aggregates over the user table in a single
// round-trip — Postgres folds them into a single sequential scan with
// FILTER predicates, so it's strictly cheaper than three Prisma
// .count() calls.
//
// Cached cross-request (60s revalidate) so spamming the search box
// doesn't fan into the DB on every keystroke. unstable_cache also
// deduplicates within a single render, so a Suspense fan-out that
// happens to call this twice gets one query.

export type UsersListStats = {
  /** All users in the DB, regardless of role or status. */
  totalUsers: number;
  /** Users with `is_banned = true`. */
  totalBanned: number;
  /** Users created in the rolling last 24h. */
  signups24h: number;
};

const cachedUsersListStats = unstable_cache(
  async (): Promise<UsersListStats> => {
    const db = await getDb();
    const rows = await db.$queryRaw<
      {
        total: string;
        banned: string;
        signups_24h: string;
      }[]
    >`
      SELECT
        COUNT(*)::text                                                                   AS total,
        COUNT(*) FILTER (WHERE is_banned = true)::text                                   AS banned,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::text          AS signups_24h
      FROM "user"
    `;
    const r = rows[0];
    return {
      totalUsers: Number(r?.total ?? 0),
      totalBanned: Number(r?.banned ?? 0),
      signups24h: Number(r?.signups_24h ?? 0),
    };
  },
  ["users-list-stats-v1"],
  { revalidate: 60, tags: ["users-list-stats"] },
);

export async function getUsersListStats(): Promise<UsersListStats> {
  return cachedUsersListStats();
}
