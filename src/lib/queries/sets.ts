import { getDb } from "@/lib/db";
import type { PaginatedResult } from "@/lib/types";
import { Prisma } from "@/generated/prisma/client";

export type SetListItem = {
  id: string;
  name: string;
  series: string;
  imageUrl: string;
  language: string;
  tcgplayerId: number;
  releaseDate: string | null;
  cardCount: number;
  createdAt: string;
};

export async function getSetsList(params: {
  page?: number;
  perPage?: number;
  search?: string;
  series?: string;
  sortBy?: string;
  sortOrder?: string;
}): Promise<PaginatedResult<SetListItem>> {
  const {
    page = 1,
    perPage = 20,
    search,
    series,
    sortBy = "created_at",
    sortOrder = "desc",
  } = params;
  const db = await getDb();

  const where: Prisma.setsWhereInput = {};

  if (search) {
    where.name = { contains: search, mode: "insensitive" };
  }

  if (series) {
    where.series = series;
  }

  const orderBy: Prisma.setsOrderByWithRelationInput = {};
  const validSortFields = ["created_at", "name", "release_date"];
  const field = validSortFields.includes(sortBy) ? sortBy : "created_at";
  const order = sortOrder === "asc" ? "asc" : "desc";
  (orderBy as Record<string, string>)[field] = order;

  const [sets, total] = await Promise.all([
    db.sets.findMany({
      where,
      orderBy,
      skip: (page - 1) * perPage,
      take: perPage,
      include: {
        _count: { select: { cards: true } },
      },
    }),
    db.sets.count({ where }),
  ]);

  return {
    data: sets.map((s) => ({
      id: s.id,
      name: s.name,
      series: s.series,
      imageUrl: s.image_url,
      language: s.language,
      tcgplayerId: s.tcgplayer_id,
      releaseDate: s.release_date?.toISOString() ?? null,
      cardCount: s._count.cards,
      createdAt: s.created_at.toISOString(),
    })),
    total,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
  };
}

/** Distinct series values for the toolbar filter. */
export async function getSeriesList(): Promise<string[]> {
  const db = await getDb();
  const result = await db.sets.groupBy({
    by: ["series"],
    orderBy: { series: "asc" },
  });
  return result.map((r) => r.series);
}

export type SetsStats = {
  total: number;
  totalSeries: number;
  totalCards: number;
};

export async function getSetsStats(): Promise<SetsStats> {
  const db = await getDb();
  const [total, seriesGroups, totalCards] = await Promise.all([
    db.sets.count(),
    db.sets.groupBy({ by: ["series"] }),
    db.cards.count(),
  ]);

  return {
    total,
    totalSeries: seriesGroups.length,
    totalCards,
  };
}
