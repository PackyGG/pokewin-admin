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

  return {
    openings: buckets,
    revenue: revBuckets,
    payout: payBuckets,
    rtp,
    houseEdge,
    daily,
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
  }
) {
  const where: Prisma.game_sessionsWhereInput = {
    game_type: "pack",
    game_id: packId,
  };

  if (filters?.dateFrom || filters?.dateTo) {
    where.created_at = {};
    if (filters.dateFrom) where.created_at.gte = new Date(filters.dateFrom);
    if (filters?.dateTo) {
      const to = new Date(filters.dateTo);
      to.setDate(to.getDate() + 1);
      where.created_at.lte = to;
    }
  }

  if (filters?.search) {
    where.user = {
      OR: [
        { username: { contains: filters.search, mode: "insensitive" } },
        { email: { contains: filters.search, mode: "insensitive" } },
        { id: filters.search },
      ],
    };
  }

  const [sessions, total] = await Promise.all([
    db.game_sessions.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        user: { select: { id: true, username: true, email: true } },
        provably_fair_results: {
          include: {
            user_inventory: {
              select: { card_id: true, value_at_obtained: true },
            },
          },
        },
      },
    }),
    db.game_sessions.count({ where }),
  ]);

  // Collect all card IDs to fetch in one batch
  const cardIds = new Set<string>();
  for (const s of sessions) {
    for (const pf of s.provably_fair_results) {
      if (pf.user_inventory?.card_id) cardIds.add(pf.user_inventory.card_id);
    }
  }

  const cardsMap = new Map<string, { name: string; image_url: string | null; rarity: string | null; price: unknown }>();
  if (cardIds.size > 0) {
    const cards = await db.cards.findMany({
      where: { id: { in: Array.from(cardIds) } },
      select: { id: true, name: true, image_url: true, rarity: true, price: true },
    });
    for (const c of cards) cardsMap.set(c.id, c);
  }

  return {
    data: sessions.map((s) => ({
      id: s.id,
      userId: s.user_id,
      username: s.user?.username ?? null,
      email: s.user?.email ?? null,
      betAmount: toNumber(s.bet_amount),
      cardsWon: s.provably_fair_results
        .filter((pf) => pf.user_inventory?.card_id && cardsMap.has(pf.user_inventory.card_id))
        .map((pf) => {
          const card = cardsMap.get(pf.user_inventory!.card_id)!;
          return {
            name: card.name,
            imageUrl: card.image_url,
            rarity: card.rarity,
            priceUsd: toNumber(card.price),
          };
        }),
      totalPayout: s.provably_fair_results.reduce((sum, pf) => {
        if (pf.user_inventory) return sum + toNumber(pf.user_inventory.value_at_obtained);
        return sum;
      }, 0),
      betTxId: s.bet_ledger_tx_id,
      createdAt: s.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}
