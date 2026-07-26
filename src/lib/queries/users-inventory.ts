import { sql, type SQL } from "drizzle-orm";
import { getDrizzleDb } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";

export async function getUserInventory(
  userId: string,
  page: number = 1,
  perPage: number = 20,
  filters?: {
    rarity?: string;
    status?: string;
    search?: string;
    sort?: string;
    priceMin?: number;
    priceMax?: number;
  },
) {
  const db = await getDrizzleDb();
  const predicates: SQL[] = [sql`ui.user_id = ${userId}`];

  if (filters?.status === "owned") {
    predicates.push(sql`ui.sold_at IS NULL`, sql`ui.exchanged_at IS NULL`);
  } else if (filters?.status === "sold") {
    predicates.push(sql`ui.sold_at IS NOT NULL`);
  } else if (filters?.status === "exchanged") {
    predicates.push(sql`ui.exchanged_at IS NOT NULL`);
  } else if (filters?.status === "disposed") {
    // Items that have left the user's owned inventory either via sale or
    // exchange. Used for the combined "Sold & Exchanged" admin section.
    predicates.push(sql`(ui.sold_at IS NOT NULL OR ui.exchanged_at IS NOT NULL)`);
  }

  if (filters?.priceMin != null) {
    predicates.push(sql`ui.value_at_obtained >= ${filters.priceMin}`);
  }
  if (filters?.priceMax != null) {
    predicates.push(sql`ui.value_at_obtained <= ${filters.priceMax}`);
  }

  if (filters?.rarity)
    predicates.push(sql`c.rarity ILIKE ${filters.rarity}`);
  if (filters?.search)
    predicates.push(sql`c.name ILIKE ${`%${filters.search}%`}`);

  const orderBy =
    filters?.sort === "price_asc"
      ? sql`ui.value_at_obtained ASC`
      : filters?.sort === "price_desc"
        ? sql`ui.value_at_obtained DESC`
        : filters?.sort === "oldest"
          ? sql`ui.created_at ASC`
          : sql`ui.created_at DESC`;
  const safePage = Math.max(1, Math.trunc(page) || 1);
  const safePerPage = Math.min(200, Math.max(1, Math.trunc(perPage) || 20));
  const offset = (safePage - 1) * safePerPage;
  const whereSql = sql.join(predicates, sql` AND `);

  const [itemsResult, totalResult] = await Promise.all([
    db.execute<{
      id: string;
      card_name: string | null;
      image_url: string | null;
      rarity: string | null;
      value_at_obtained: string;
      source_type: string;
      obtained_at: Date | string;
      sold_at: Date | string | null;
      exchanged_at: Date | string | null;
    }>(sql`
      SELECT
        ui.id,
        c.name AS card_name,
        c.image_url,
        c.rarity,
        ui.value_at_obtained::text AS value_at_obtained,
        ui.source_type::text AS source_type,
        ui.obtained_at,
        ui.sold_at,
        ui.exchanged_at
      FROM user_inventory ui
      LEFT JOIN cards c ON c.id = ui.card_id
      WHERE ${whereSql}
      ORDER BY ${orderBy}
      LIMIT ${safePerPage}
      OFFSET ${offset}
    `),
    db.execute<{ total: string }>(sql`
      SELECT COUNT(*)::text AS total
      FROM user_inventory ui
      LEFT JOIN cards c ON c.id = ui.card_id
      WHERE ${whereSql}
    `),
  ]);
  const total = Number(totalResult.rows[0]?.total ?? 0);

  return {
    data: itemsResult.rows.map((item) => {
      return {
        id: item.id,
        cardName: item.card_name ?? "Unknown Card",
        imageUrl: item.image_url,
        rarity: item.rarity,
        value: toNumber(item.value_at_obtained),
        sourceType: item.source_type,
        obtainedAt: new Date(item.obtained_at).toISOString(),
        soldAt: item.sold_at ? new Date(item.sold_at).toISOString() : null,
        exchangedAt: item.exchanged_at
          ? new Date(item.exchanged_at).toISOString()
          : null,
      };
    }),
    total,
    page: safePage,
    perPage: safePerPage,
    totalPages: Math.ceil(total / safePerPage),
  };
}
