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

  // Discord snowflake IDs are 17-20 digit numeric strings. We match the
  // linked Discord account (account.providerId = 'discord', account.accountId
  // = snowflake) only when the search looks like one — otherwise a generic
  // numeric username would trigger an unnecessary join.
  const isDiscordId = /^\d{17,20}$/.test(search ?? "");

  if (search) {
    const or: Prisma.UserWhereInput[] = [
      { username: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
      { id: search },
    ];
    if (isDiscordId) {
      or.push({
        account: {
          some: { providerId: "discord", accountId: search },
        },
      });
    }
    where.OR = or;
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
    if (search) {
      const safe = search.replace(/'/g, "''");
      const discordClause = isDiscordId
        ? ` OR EXISTS (SELECT 1 FROM account a WHERE a."userId" = u.id AND a."providerId" = 'discord' AND a."accountId" = '${safe}')`
        : "";
      whereSql.push(
        `(u.username ILIKE '%${safe}%' OR u.email ILIKE '%${safe}%' OR u.id = '${safe}'${discordClause})`,
      );
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
