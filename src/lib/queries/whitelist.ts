import { whitelistPool } from "@/lib/whitelist-db";

export type WhitelistUser = {
  id: string;
  discordId: string;
  username: string;
  referralCode: string;
  avatar: string | null;
  email: string | null;
  referredBy: string | null;
  flagged: boolean;
  createdAt: Date;
  packyUserId: string | null;
  claimedAt: Date | null;
};

export async function getWhitelistUsers({
  page,
  perPage,
  search,
}: {
  page: number;
  perPage: number;
  search?: string;
}) {
  const offset = (page - 1) * perPage;

  let whereClause = "";
  const params: (string | number)[] = [];

  if (search) {
    whereClause = `WHERE "discordId" ILIKE $1 OR "username" ILIKE $1`;
    params.push(`%${search}%`);
  }

  const countQuery = `SELECT COUNT(*) FROM "User" ${whereClause}`;
  const countResult = await whitelistPool.query(countQuery, params);
  const total = parseInt(countResult.rows[0].count, 10);

  const dataParams = [...params, perPage, offset];
  const dataQuery = `
    SELECT * FROM "User" ${whereClause}
    ORDER BY "createdAt" DESC
    LIMIT $${params.length + 1} OFFSET $${params.length + 2}
  `;
  const dataResult = await whitelistPool.query(dataQuery, dataParams);

  return {
    data: dataResult.rows as WhitelistUser[],
    page,
    perPage,
    total,
    totalPages: Math.ceil(total / perPage),
  };
}
