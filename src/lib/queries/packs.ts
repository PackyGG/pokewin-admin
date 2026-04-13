import { db } from "@/lib/db";
import { toNumber } from "@/lib/utils/decimal";
import type { PaginatedResult } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";

export type PackListCard = {
  id: string;
  name: string;
  imageUrl: string | null;
  rarity: string | null;
};

export type PackListItem = {
  id: string;
  name: string;
  slug: string;
  imageUrl: string | null;
  priceUsd: number;
  cardsPerOpen: number;
  totalOpenings: number;
  totalRevenue: number;
  totalPayout: number;
  actualRtp: number;
  actualHouseEdge: number;
  active: boolean;
  cards: PackListCard[];
};

export async function getPacks(params: {
  page?: number;
  perPage?: number;
  search?: string;
  active?: string;
  sortBy?: string;
  sortOrder?: string;
}): Promise<PaginatedResult<PackListItem>> {
  const {
    page = 1,
    perPage = 20,
    search,
    active,
    sortBy = "created_at",
    sortOrder = "desc",
  } = params;

  const where: Prisma.packsWhereInput = {};

  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { slug: { contains: search, mode: "insensitive" } },
    ];
  }

  if (active === "active") where.active = true;
  else if (active === "inactive") where.active = false;

  const orderBy: Prisma.packsOrderByWithRelationInput = {};
  const validSortFields = ["created_at", "name", "total_revenue", "total_openings", "actual_house_edge"];
  const field = validSortFields.includes(sortBy) ? sortBy : "created_at";
  const order = sortOrder === "asc" ? "asc" : "desc";
  (orderBy as Record<string, string>)[field] = order;

  const [packs, total] = await Promise.all([
    db.packs.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        pack_cards: {
          include: { cards: { select: { id: true, name: true, image_url: true, rarity: true } } },
          orderBy: { order: "asc" },
        },
      },
    }),
    db.packs.count({ where }),
  ]);

  return {
    data: packs.map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      imageUrl: p.image_url,
      priceUsd: toNumber(p.price),
      cardsPerOpen: p.cards_per_open,
      totalOpenings: Number(p.total_openings),
      totalRevenue: toNumber(p.total_revenue),
      totalPayout: toNumber(p.total_payout),
      actualRtp: toNumber(p.actual_rtp),
      actualHouseEdge: toNumber(p.actual_house_edge),
      active: p.active,
      cards: p.pack_cards.map((pc) => ({
        id: pc.cards.id,
        name: pc.cards.name,
        imageUrl: pc.cards.image_url,
        rarity: pc.cards.rarity,
      })),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

export async function getPackDetail(id: string) {
  const pack = await db.packs.findUnique({
    where: { id },
    include: {
      pack_cards: {
        include: {
          cards: {
            include: {
              sets: { select: { name: true } },
            },
          },
        },
        orderBy: { order: "asc" },
      },
    },
  });

  if (!pack) return null;

  const totalWeight = pack.pack_cards.reduce((sum, pc) => sum + pc.weight, 0);

  return {
    id: pack.id,
    name: pack.name,
    slug: pack.slug,
    description: pack.description,
    imageUrl: pack.image_url,
    priceUsd: toNumber(pack.price),
    cardsPerOpen: pack.cards_per_open,
    totalOpenings: Number(pack.total_openings),
    totalRevenue: toNumber(pack.total_revenue),
    totalPayout: toNumber(pack.total_payout),
    actualRtp: toNumber(pack.actual_rtp),
    actualHouseEdge: toNumber(pack.actual_house_edge),
    active: pack.active,
    packType: pack.pack_type,
    tags: pack.tags,
    difficulty: pack.difficulty,
    cards: pack.pack_cards.map((pc) => ({
      id: pc.id,
      cardId: pc.card_id,
      name: pc.cards.name,
      imageUrl: pc.cards.image_url,
      priceUsd: toNumber(pc.cards.price),
      rarity: pc.cards.rarity,
      setName: pc.cards.sets?.name ?? null,
      weight: pc.weight,
      probability: totalWeight > 0 ? ((pc.weight / totalWeight) * 100) : 0,
      color: pc.color,
      animation: pc.animation,
      order: pc.order,
    })),
  };
}

export type PackStats = {
  openings: { d1: number; d3: number; d7: number; d30: number; all: number };
  revenue: { d1: number; d3: number; d7: number; d30: number; all: number };
  payout: { d1: number; d3: number; d7: number; d30: number; all: number };
  rtp: number;
  houseEdge: number;
  daily: {
    date: string;
    soloOpenings: number;
    battleOpenings: number;
    borrowedOpenings: number;
    sponsoredOpenings: number;
    revenue: number;
    payout: number;
  }[];
  // Pie chart breakdown: solo vs battle, each with borrow% / sponsored% detail
  soloBreakdown: { label: string; count: number }[];
  battleBreakdown: { label: string; count: number }[];
};

export async function getPackStats(
  packId: string,
  packPrice: number,
  dbTotals: { totalPayout: number; actualRtp: number },
): Promise<PackStats> {
  // The single source of truth: provably_fair_results.result_metadata->>'pack_id'
  // tells us exactly which pack produced each card in both solo and battle openings.
  const rows = await db.$queryRawUnsafe<
    {
      date: Date;
      openings: string;
      solo: string;
      battle: string;
      borrowed: string;
      sponsored: string;
      payout: string;
    }[]
  >(`
    SELECT
      DATE(pf.created_at) AS date,
      COUNT(*)::text AS openings,
      COUNT(*) FILTER (WHERE pf.battle_id IS NULL)::text AS solo,
      COUNT(*) FILTER (WHERE pf.battle_id IS NOT NULL)::text AS battle,
      COUNT(*) FILTER (WHERE b.borrow_percentage > 0)::text AS borrowed,
      COUNT(*) FILTER (WHERE b.sponsorship_percentage > 0)::text AS sponsored,
      COALESCE(SUM(c.price::numeric), 0)::text AS payout
    FROM provably_fair_results pf
    LEFT JOIN cards c ON c.id = (pf.result_metadata->>'card_id')::uuid
    LEFT JOIN battles b ON b.id = pf.battle_id
    WHERE pf.result_metadata->>'pack_id' = $1
    GROUP BY DATE(pf.created_at)
    ORDER BY date
  `, packId);

  const now = new Date();
  const day = 24 * 60 * 60 * 1000;
  const since1 = new Date(now.getTime() - 1 * day);
  const since3 = new Date(now.getTime() - 3 * day);
  const since7 = new Date(now.getTime() - 7 * day);
  const since30 = new Date(now.getTime() - 30 * day);

  const buckets = { d1: 0, d3: 0, d7: 0, d30: 0, all: 0 };
  const revBuckets = { ...buckets };
  const payBuckets = { ...buckets };

  const daily: PackStats["daily"] = [];

  for (const r of rows) {
    const dateStr = new Date(r.date).toISOString().slice(0, 10);
    const d = new Date(r.date);
    const totalOpenings = Number(r.openings);
    const soloOpenings = Number(r.solo);
    const battleOpenings = Number(r.battle);
    const borrowedOpenings = Number(r.borrowed);
    const sponsoredOpenings = Number(r.sponsored);
    const payout = parseFloat(r.payout);
    // Revenue = openings × pack price (each opening = one instance of this pack)
    const revenue = totalOpenings * packPrice;

    daily.push({
      date: dateStr,
      soloOpenings,
      battleOpenings,
      borrowedOpenings,
      sponsoredOpenings,
      revenue,
      payout,
    });

    buckets.all += totalOpenings;
    revBuckets.all += revenue;
    payBuckets.all += payout;

    if (d >= since30) {
      buckets.d30 += totalOpenings;
      revBuckets.d30 += revenue;
      payBuckets.d30 += payout;
    }
    if (d >= since7) {
      buckets.d7 += totalOpenings;
      revBuckets.d7 += revenue;
      payBuckets.d7 += payout;
    }
    if (d >= since3) {
      buckets.d3 += totalOpenings;
      revBuckets.d3 += revenue;
      payBuckets.d3 += payout;
    }
    if (d >= since1) {
      buckets.d1 += totalOpenings;
      revBuckets.d1 += revenue;
      payBuckets.d1 += payout;
    }
  }

  const totalRevenue = revBuckets.all;
  // Payout from our query is unreliable (unassigned high-value cards have no
  // inventory_item_id). Use the backend's pre-computed value instead.
  const totalPayout = dbTotals.totalPayout;
  payBuckets.all = totalPayout;
  // RTP from the backend's pre-computed value (stored as percentage, e.g. 85.85)
  const dbRtp = dbTotals.actualRtp;
  const rtp = dbRtp > 2 ? dbRtp / 100 : dbRtp; // normalize to 0-1
  const houseEdge = 1 - rtp;

  // Breakdown for pie charts: borrow_percentage / sponsorship_percentage per mode
  const breakdownRows = await db.$queryRawUnsafe<
    {
      is_battle: boolean;
      borrow_pct: number;
      sponsor_pct: number;
      count: string;
    }[]
  >(`
    SELECT
      (pf.battle_id IS NOT NULL) AS is_battle,
      COALESCE(b.borrow_percentage, 0) AS borrow_pct,
      COALESCE(b.sponsorship_percentage, 0) AS sponsor_pct,
      COUNT(*)::text AS count
    FROM provably_fair_results pf
    LEFT JOIN battles b ON b.id = pf.battle_id
    WHERE pf.result_metadata->>'pack_id' = $1
    GROUP BY is_battle, borrow_pct, sponsor_pct
    ORDER BY count DESC
  `, packId);

  function buildBreakdown(isBattle: boolean) {
    const filtered = breakdownRows.filter((r) => r.is_battle === isBattle);
    const items: { label: string; count: number }[] = [];
    for (const r of filtered) {
      const count = Number(r.count);
      if (r.borrow_pct > 0) {
        items.push({ label: `Borrowed ${r.borrow_pct}%`, count });
      } else if (r.sponsor_pct > 0) {
        items.push({ label: `Sponsored ${r.sponsor_pct}%`, count });
      } else {
        items.push({ label: "Normal", count });
      }
    }
    // Merge same labels (e.g. multiple rows with borrow 90% from different sponsor combos)
    const merged = new Map<string, number>();
    for (const i of items) {
      merged.set(i.label, (merged.get(i.label) ?? 0) + i.count);
    }
    return [...merged.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
  }

  return {
    openings: buckets,
    revenue: revBuckets,
    payout: payBuckets,
    rtp,
    houseEdge,
    daily,
    soloBreakdown: buildBreakdown(false),
    battleBreakdown: buildBreakdown(true),
  };
}

export async function getPackGames(
  packId: string,
  page: number = 1,
  perPage: number = 20,
  filters?: {
    dateFrom?: string;
    dateTo?: string;
    search?: string;
    sortBy?: string;
    sortOrder?: string;
    type?: string; // "all" | "solo" | "battle"
  }
) {
  // Build WHERE clauses for the raw query
  const conditions: string[] = [`pf.result_metadata->>'pack_id' = $1`];
  const params: unknown[] = [packId];
  let paramIdx = 2;

  if (filters?.type === "solo") {
    conditions.push("pf.battle_id IS NULL");
  } else if (filters?.type === "battle") {
    conditions.push("pf.battle_id IS NOT NULL");
  }

  if (filters?.dateFrom) {
    conditions.push(`pf.created_at >= $${paramIdx}::timestamp`);
    params.push(new Date(filters.dateFrom));
    paramIdx++;
  }
  if (filters?.dateTo) {
    const to = new Date(filters.dateTo);
    to.setDate(to.getDate() + 1);
    conditions.push(`pf.created_at < $${paramIdx}::timestamp`);
    params.push(to);
    paramIdx++;
  }
  if (filters?.search) {
    conditions.push(`(u.username ILIKE $${paramIdx} OR u.email ILIKE $${paramIdx} OR u.id = $${paramIdx + 1})`);
    params.push(`%${filters.search}%`, filters.search);
    paramIdx += 2;
  }

  const whereClause = conditions.join(" AND ");
  const orderCol =
    filters?.sortBy === "payout"
      ? "card_price"
      : filters?.sortBy === "date"
        ? "pf.created_at"
        : "pf.created_at";
  const orderDir = filters?.sortOrder === "asc" ? "ASC" : "DESC";

  const countResult = await db.$queryRawUnsafe<{ count: string }[]>(
    `SELECT COUNT(*)::text AS count
     FROM provably_fair_results pf
     LEFT JOIN "user" u ON u.id = (pf.result_metadata->>'user_id')
     WHERE ${whereClause}`,
    ...params,
  );
  const total = Number(countResult[0]?.count ?? 0);

  const rows = await db.$queryRawUnsafe<
    {
      id: string;
      user_id: string | null;
      username: string | null;
      email: string | null;
      battle_id: string | null;
      card_id: string | null;
      card_name: string | null;
      card_image_url: string | null;
      card_rarity: string | null;
      card_price: string;
      is_borrowed: boolean;
      is_sponsored: boolean;
      created_at: Date;
    }[]
  >(
    `SELECT
       pf.id,
       (pf.result_metadata->>'user_id') AS user_id,
       u.username,
       u.email,
       pf.battle_id,
       c.id AS card_id,
       c.name AS card_name,
       c.image_url AS card_image_url,
       c.rarity AS card_rarity,
       COALESCE(c.price::text, '0') AS card_price,
       COALESCE(b.borrow_percentage > 0, false) AS is_borrowed,
       COALESCE(b.sponsorship_percentage > 0, false) AS is_sponsored,
       pf.created_at
     FROM provably_fair_results pf
     LEFT JOIN cards c ON c.id = (pf.result_metadata->>'card_id')::uuid
     LEFT JOIN "user" u ON u.id = (pf.result_metadata->>'user_id')
     LEFT JOIN battles b ON b.id = pf.battle_id
     WHERE ${whereClause}
     ORDER BY ${orderCol} ${orderDir}
     LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`,
    ...params,
  );

  return {
    data: rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      email: r.email,
      type: r.battle_id ? "battle" : "solo" as "battle" | "solo",
      isBorrowed: r.is_borrowed,
      isSponsored: r.is_sponsored,
      cardName: r.card_name,
      cardImageUrl: r.card_image_url,
      cardRarity: r.card_rarity,
      cardPrice: parseFloat(r.card_price),
      createdAt: r.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
